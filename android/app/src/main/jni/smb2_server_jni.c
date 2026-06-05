#include <jni.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <dirent.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <pthread.h>
#include <android/log.h>

#include "smb2.h"
#include "libsmb2.h"
#include "libsmb2-raw.h"

#define TAG "smb2-jni"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

#define MAX_HANDLES 256
#define HANDLE_MAGIC 0x534D4232

#define MAX_TRANSFERS 128

struct file_handle {
    int used;
    int fd;
    int is_directory;
    int delete_on_close;
    int transfer_slot;
    uint64_t bytes_written;
    char path[1024];
};

struct transfer_entry {
    char file_name[256];
    uint64_t total_bytes;
    int status; // 0=active, 1=completed
};

static struct {
    struct transfer_entry entries[MAX_TRANSFERS];
    int count;
    pthread_mutex_t mutex;
} transfer_history;

static struct {
    struct file_handle handles[MAX_HANDLES];
    int count;
    pthread_mutex_t mutex;
} handle_table;

static struct smb2_server server;
static int server_running = 0;
static int server_port = 1445;
static int connection_count = 0;
static long long bytes_written = 0;
static char share_path[1024] = "/storage/emulated/0";
static char share_name[256] = "Anime";

static pthread_t server_thread;
static pthread_mutex_t stats_mutex = PTHREAD_MUTEX_INITIALIZER;

static void mark_transfer_cancelled(const char *real_path);

static int alloc_handle(const char *real_path) {
    pthread_mutex_lock(&handle_table.mutex);
    for (int i = 0; i < MAX_HANDLES; i++) {
        if (!handle_table.handles[i].used) {
            handle_table.handles[i].used = 1;
            handle_table.handles[i].fd = -1;
            handle_table.handles[i].is_directory = 0;
            handle_table.handles[i].delete_on_close = 0;
            handle_table.handles[i].bytes_written = 0;
            handle_table.handles[i].transfer_slot = -1;
            strncpy(handle_table.handles[i].path, real_path, sizeof(handle_table.handles[i].path) - 1);
            handle_table.handles[i].path[sizeof(handle_table.handles[i].path) - 1] = '\0';
            handle_table.count++;
            pthread_mutex_unlock(&handle_table.mutex);
            return i;
        }
    }
    pthread_mutex_unlock(&handle_table.mutex);
    return -1;
}

static void free_handle(int idx) {
    pthread_mutex_lock(&handle_table.mutex);
    if (idx >= 0 && idx < MAX_HANDLES && handle_table.handles[idx].used) {
        if (handle_table.handles[idx].fd >= 0) {
            close(handle_table.handles[idx].fd);
        }
        int slot = handle_table.handles[idx].transfer_slot;
        if (slot >= 0 && slot < transfer_history.count) {
            transfer_history.entries[slot].status = 1;
        }
        memset(&handle_table.handles[idx], 0, sizeof(struct file_handle));
        handle_table.count--;
    }
    pthread_mutex_unlock(&handle_table.mutex);
}

static void file_id_to_idx(smb2_file_id fid, int *idx) {
    memcpy(idx, fid, sizeof(int));
}

static void idx_to_file_id(smb2_file_id fid, int idx) {
    memset(fid, 0, SMB2_FD_SIZE);
    memcpy(fid, &idx, sizeof(int));
}

static void build_real_path(const char *name, char *out, size_t out_size) {
    if (name && name[0] == '\\') {
        const char *p = name + 1;
        const char *slash = strchr(p, '\\');
        if (slash) {
            snprintf(out, out_size, "%s%s", share_path, slash);
        } else {
            snprintf(out, out_size, "%s", share_path);
        }
    } else if (name) {
        snprintf(out, out_size, "%s/%s", share_path, name);
    } else {
        snprintf(out, out_size, "%s", share_path);
    }
    for (char *c = out; *c; c++) {
        if (*c == '\\') *c = '/';
    }
}

static int authorize_user(struct smb2_server *srvr, struct smb2_context *smb2,
                          const char *user, const char *domain, const char *workstation) {
    LOGI("authorize_user: user=%s domain=%s", user ? user : "(null)", domain ? domain : "(null)");
    return 0;
}

static int session_established(struct smb2_server *srvr, struct smb2_context *smb2) {
    uint16_t dialect = smb2_get_dialect(smb2);
    LOGI("session_established: dialect=0x%04x", dialect);
    return 0;
}

static int logoff_cmd(struct smb2_server *srvr, struct smb2_context *smb2) {
    LOGI("logoff_cmd");
    return 0;
}

static int tree_connect_cmd(struct smb2_server *srvr, struct smb2_context *smb2,
                            struct smb2_tree_connect_request *req,
                            struct smb2_tree_connect_reply *rep) {
    LOGI("tree_connect_cmd");
    rep->share_type = SMB2_SHARE_TYPE_DISK;
    rep->maximal_access = 0x101f01ff;
    rep->share_flags = 0;
    rep->capabilities = 0;
    return 0;
}

static int tree_disconnect_cmd(struct smb2_server *srvr, struct smb2_context *smb2,
                               const uint32_t tree_id) {
    LOGI("tree_disconnect_cmd");
    return 0;
}

static int create_cmd(struct smb2_server *srvr, struct smb2_context *smb2,
                      struct smb2_create_request *req,
                      struct smb2_create_reply *rep) {
    char real_path[1024];
    build_real_path(req->name, real_path, sizeof(real_path));
    LOGI("create_cmd: name=%s real=%s create_options=0x%08x create_disposition=0x%08x",
         req->name ? req->name : "(null)", real_path,
         req->create_options, req->create_disposition);

    int want_dir = (req->create_options & SMB2_FILE_DIRECTORY_FILE) != 0;
    struct stat st;
    int exists = (stat(real_path, &st) == 0);

    int idx = alloc_handle(real_path);
    if (idx < 0) {
        LOGE("create_cmd: no free handle slots");
        return -ENOMEM;
    }

    handle_table.handles[idx].delete_on_close = 
        (req->create_options & SMB2_FILE_DELETE_ON_CLOSE) ? 1 : 0;

    if (want_dir) {
        if (!exists) {
            if (req->create_disposition == SMB2_FILE_OPEN) {
                free_handle(idx);
                return -ENOENT;
            }
            if (mkdir(real_path, 0755) != 0) {
                LOGE("create_cmd: mkdir failed %s: %s", real_path, strerror(errno));
                free_handle(idx);
                return -errno;
            }
        } else if (!S_ISDIR(st.st_mode)) {
            free_handle(idx);
            return -ENOTDIR;
        } else if (req->create_disposition == SMB2_FILE_CREATE) {
            // FILE_CREATE on existing dir: be lenient, just open it.
            // Many clients send FILE_CREATE unconditionally for directories,
            // and returning -EEXIST causes them to abort the entire transfer.
        }
        handle_table.handles[idx].is_directory = 1;
        rep->file_attributes = SMB2_FILE_ATTRIBUTE_DIRECTORY;
        idx_to_file_id(rep->file_id, idx);
        if (handle_table.handles[idx].delete_on_close) {
            LOGI("create_cmd: DELETE_ON_CLOSE dir: %s", real_path);
            rmdir(real_path);
            mark_transfer_cancelled(real_path);
        }
        return 0;
    }

    if (!exists) {
        switch (req->create_disposition) {
        case SMB2_FILE_OPEN:
        case SMB2_FILE_OVERWRITE:
            free_handle(idx);
            return -ENOENT;
        default: {
            int fd = open(real_path, O_RDWR | O_CREAT, 0644);
            if (fd < 0) {
                LOGE("create_cmd: open failed %s: %s", real_path, strerror(errno));
                free_handle(idx);
                return -errno;
            }
            handle_table.handles[idx].fd = fd;
            rep->file_attributes = SMB2_FILE_ATTRIBUTE_NORMAL;
            idx_to_file_id(rep->file_id, idx);
            if (handle_table.handles[idx].delete_on_close) {
                LOGI("create_cmd: DELETE_ON_CLOSE: %s", real_path);
                unlink(real_path);
                mark_transfer_cancelled(real_path);
            }
            return 0;
        }
        }
    }

    if (S_ISDIR(st.st_mode)) {
        free_handle(idx);
        return -EISDIR;
    }

    switch (req->create_disposition) {
    case SMB2_FILE_CREATE:
        free_handle(idx);
        return -EEXIST;
    case SMB2_FILE_SUPERSEDE:
    case SMB2_FILE_OVERWRITE:
    case SMB2_FILE_OVERWRITE_IF: {
        int fd = open(real_path, O_RDWR | O_TRUNC, 0644);
        if (fd < 0) {
            LOGE("create_cmd: open/trunc failed %s: %s", real_path, strerror(errno));
            free_handle(idx);
            return -errno;
        }
        handle_table.handles[idx].fd = fd;
        rep->file_attributes = SMB2_FILE_ATTRIBUTE_NORMAL;
        idx_to_file_id(rep->file_id, idx);
        if (handle_table.handles[idx].delete_on_close) {
            LOGI("create_cmd: DELETE_ON_CLOSE: %s", real_path);
            unlink(real_path);
            mark_transfer_cancelled(real_path);
        }
        return 0;
    }
    default: {
        int fd = open(real_path, O_RDWR, 0644);
        if (fd < 0) {
            LOGE("create_cmd: open failed %s: %s", real_path, strerror(errno));
            free_handle(idx);
            return -errno;
        }
        handle_table.handles[idx].fd = fd;
        rep->file_attributes = SMB2_FILE_ATTRIBUTE_NORMAL;
        idx_to_file_id(rep->file_id, idx);
        if (handle_table.handles[idx].delete_on_close) {
            LOGI("create_cmd: DELETE_ON_CLOSE: %s", real_path);
            unlink(real_path);
            mark_transfer_cancelled(real_path);
        }
        return 0;
    }
    }
}

static int close_cmd(struct smb2_server *srvr, struct smb2_context *smb2,
                     struct smb2_close_request *req,
                     struct smb2_close_reply *rep) {
    int idx;
    file_id_to_idx(req->file_id, &idx);
    LOGI("close_cmd: idx=%d", idx);

    if (idx >= 0 && idx < MAX_HANDLES && handle_table.handles[idx].used) {
        struct stat st;
        if (stat(handle_table.handles[idx].path, &st) == 0) {
            rep->allocation_size = (uint64_t)st.st_size;
            rep->end_of_file = (uint64_t)st.st_size;
            rep->file_attributes = S_ISDIR(st.st_mode)
                ? SMB2_FILE_ATTRIBUTE_DIRECTORY
                : SMB2_FILE_ATTRIBUTE_NORMAL;
        }
    }
    free_handle(idx);
    return 0;
}

static int flush_cmd(struct smb2_server *srvr, struct smb2_context *smb2,
                     struct smb2_flush_request *req) {
    int idx;
    file_id_to_idx(req->file_id, &idx);
    LOGI("flush_cmd: idx=%d", idx);
    if (idx >= 0 && idx < MAX_HANDLES && handle_table.handles[idx].used && handle_table.handles[idx].fd >= 0) {
        fsync(handle_table.handles[idx].fd);
    }
    return 0;
}

static int read_cmd(struct smb2_server *srvr, struct smb2_context *smb2,
                    struct smb2_read_request *req,
                    struct smb2_read_reply *rep) {
    int idx;
    file_id_to_idx(req->file_id, &idx);
    LOGI("read_cmd: idx=%d offset=%llu length=%u", idx,
         (unsigned long long)req->offset, req->length);

    rep->data = NULL;
    rep->data_length = 0;
    rep->data_remaining = 0;

    if (idx < 0 || idx >= MAX_HANDLES || !handle_table.handles[idx].used) {
        return -EBADF;
    }

    struct file_handle *fh = &handle_table.handles[idx];
    if (fh->is_directory) {
        return 0;
    }

    if (fh->fd < 0) {
        return -EBADF;
    }

    rep->data = malloc(req->length);
    if (!rep->data) {
        return -ENOMEM;
    }

    ssize_t n = pread(fh->fd, rep->data, req->length, req->offset);
    if (n < 0) {
        free(rep->data);
        rep->data = NULL;
        return -errno;
    }

    rep->data_length = (uint32_t)n;
    rep->data_remaining = 0;
    return 0;
}

static int write_cmd(struct smb2_server *srvr, struct smb2_context *smb2,
                     struct smb2_write_request *req,
                     struct smb2_write_reply *rep) {
    int idx;
    file_id_to_idx(req->file_id, &idx);
    LOGI("write_cmd: idx=%d offset=%llu length=%u", idx,
         (unsigned long long)req->offset, req->length);

    if (idx < 0 || idx >= MAX_HANDLES || !handle_table.handles[idx].used) {
        rep->count = 0;
        rep->remaining = 0;
        return -EBADF;
    }

    struct file_handle *fh = &handle_table.handles[idx];
    if (fh->fd < 0) {
        rep->count = 0;
        rep->remaining = 0;
        return -EBADF;
    }

    ssize_t n = pwrite(fh->fd, req->buf, req->length, req->offset);
    if (n < 0) {
        rep->count = 0;
        rep->remaining = 0;
        return -errno;
    }

    rep->count = (uint32_t)n;
    rep->remaining = 0;

    pthread_mutex_lock(&stats_mutex);
    bytes_written += n;
    pthread_mutex_unlock(&stats_mutex);

    // Per-handle transfer tracking
    fh->bytes_written += n;
    if (fh->transfer_slot < 0) {
        pthread_mutex_lock(&transfer_history.mutex);
        if (transfer_history.count < MAX_TRANSFERS) {
            fh->transfer_slot = transfer_history.count;
            struct transfer_entry *e = &transfer_history.entries[transfer_history.count];
            // Extract just the filename from the path for display
            const char *name_only = strrchr(fh->path, '/');
            name_only = name_only ? name_only + 1 : fh->path;
            strncpy(e->file_name, name_only, sizeof(e->file_name) - 1);
            e->file_name[sizeof(e->file_name) - 1] = '\0';
            e->total_bytes = 0;
            e->status = 0;
            transfer_history.count++;
        }
        pthread_mutex_unlock(&transfer_history.mutex);
    }
    if (fh->transfer_slot >= 0 && fh->transfer_slot < transfer_history.count) {
        transfer_history.entries[fh->transfer_slot].total_bytes = fh->bytes_written;
    }

    return 0;
}

static int lock_cmd(struct smb2_server *srvr, struct smb2_context *smb2,
                    struct smb2_lock_request *req) {
    LOGI("lock_cmd");
    return 0;
}

static int ioctl_cmd(struct smb2_server *srvr, struct smb2_context *smb2,
                     struct smb2_ioctl_request *req,
                     struct smb2_ioctl_reply *rep) {
    memset(rep, 0, sizeof(*rep));
    rep->ctl_code = req->ctl_code;
    memcpy(rep->file_id, req->file_id, SMB2_FD_SIZE);

    switch (rep->ctl_code) {
    case SMB2_FSCTL_VALIDATE_NEGOTIATE_INFO:
        break;
    default:
        return 1;
    }
    return 0;
}

static int cancel_cmd(struct smb2_server *srvr, struct smb2_context *smb2) {
    LOGI("cancel_cmd");
    return 0;
}

static int echo_cmd(struct smb2_server *srvr, struct smb2_context *smb2) {
    LOGI("echo_cmd");
    return 0;
}

static int query_directory_cmd(struct smb2_server *srvr, struct smb2_context *smb2,
                               struct smb2_query_directory_request *req,
                               struct smb2_query_directory_reply *rep) {
    int idx;
    file_id_to_idx(req->file_id, &idx);
    LOGI("query_directory_cmd: idx=%d", idx);

    rep->output_buffer = NULL;
    rep->output_buffer_length = 0;

    if (idx < 0 || idx >= MAX_HANDLES || !handle_table.handles[idx].used) {
        return -EBADF;
    }

    char real_path[1024];
    build_real_path(req->name, real_path, sizeof(real_path));

    DIR *dir = opendir(real_path);
    if (!dir) {
        if (errno == ENOENT) {
            rep->output_buffer_length = 0;
            rep->output_buffer = NULL;
            return 0;
        }
        LOGE("query_directory: opendir failed %s: %s", real_path, strerror(errno));
        return -errno;
    }

    size_t alloc_size = 4096;
    uint8_t *buffer = calloc(1, alloc_size);
    if (!buffer) {
        closedir(dir);
        return -ENOMEM;
    }

    size_t offset = 0;
    int first_entry = 1;
    struct dirent *entry;

    while ((entry = readdir(dir)) != NULL) {
        if (strcmp(entry->d_name, ".") == 0) continue;

        size_t name_len = strlen(entry->d_name);
        size_t entry_size = sizeof(struct smb2_fileidbothdirectoryinformation) + name_len + 2;
        entry_size = (entry_size + 7) & ~7;

        if (offset + entry_size > alloc_size) {
            alloc_size *= 2;
            uint8_t *newbuf = realloc(buffer, alloc_size);
            if (!newbuf) {
                free(buffer);
                closedir(dir);
                return -ENOMEM;
            }
            buffer = newbuf;
        }

        struct smb2_fileidbothdirectoryinformation *fi =
            (struct smb2_fileidbothdirectoryinformation *)(buffer + offset);

        memset(fi, 0, sizeof(struct smb2_fileidbothdirectoryinformation));

        if (!first_entry) {
            fi->next_entry_offset = (uint32_t)entry_size;
        }
        first_entry = 0;

        fi->file_name_length = (uint32_t)name_len;
        fi->name = entry->d_name;

        char full_path[1024];
        snprintf(full_path, sizeof(full_path), "%s/%s", real_path, entry->d_name);
        struct stat st;
        if (stat(full_path, &st) == 0) {
            fi->end_of_file = (uint64_t)st.st_size;
            fi->allocation_size = (uint64_t)st.st_size;
            fi->file_attributes = S_ISDIR(st.st_mode)
                ? SMB2_FILE_ATTRIBUTE_DIRECTORY
                : SMB2_FILE_ATTRIBUTE_NORMAL;
        }

        offset += entry_size;
    }
    closedir(dir);

    rep->output_buffer = buffer;
    rep->output_buffer_length = (uint32_t)offset;
    return 0;
}

static int query_info_cmd(struct smb2_server *srvr, struct smb2_context *smb2,
                          struct smb2_query_info_request *req,
                          struct smb2_query_info_reply *rep) {
    int idx;
    file_id_to_idx(req->file_id, &idx);
    LOGI("query_info_cmd: idx=%d info_type=%d file_info_class=%d", idx,
         req->info_type, req->file_info_class);

    rep->output_buffer = NULL;
    rep->output_buffer_length = 0;

    char *path = NULL;
    if (idx >= 0 && idx < MAX_HANDLES && handle_table.handles[idx].used) {
        path = handle_table.handles[idx].path;
    } else {
        path = share_path;
    }

    struct stat st;
    if (stat(path, &st) != 0) {
        return -ENOENT;
    }

    switch (req->info_type) {
    case SMB2_0_INFO_FILE:
        switch (req->file_info_class) {
        case SMB2_FILE_BASIC_INFORMATION: {
            struct smb2_file_basic_info *info = calloc(1, sizeof(*info));
            if (!info) return -ENOMEM;
            info->file_attributes = S_ISDIR(st.st_mode)
                ? SMB2_FILE_ATTRIBUTE_DIRECTORY
                : SMB2_FILE_ATTRIBUTE_NORMAL;
            rep->output_buffer = info;
            rep->output_buffer_length = sizeof(*info);
            return 0;
        }
        case SMB2_FILE_STANDARD_INFORMATION: {
            struct smb2_file_standard_info *info = calloc(1, sizeof(*info));
            if (!info) return -ENOMEM;
            info->allocation_size = (uint64_t)st.st_size;
            info->end_of_file = (uint64_t)st.st_size;
            info->number_of_links = 1;
            info->delete_pending = 0;
            info->directory = S_ISDIR(st.st_mode) ? 1 : 0;
            rep->output_buffer = info;
            rep->output_buffer_length = sizeof(*info);
            return 0;
        }
        case SMB2_FILE_NETWORK_OPEN_INFORMATION: {
            struct smb2_file_network_open_info *info = calloc(1, sizeof(*info));
            if (!info) return -ENOMEM;
            info->allocation_size = (uint64_t)st.st_size;
            info->end_of_file = (uint64_t)st.st_size;
            info->file_attributes = S_ISDIR(st.st_mode)
                ? SMB2_FILE_ATTRIBUTE_DIRECTORY
                : SMB2_FILE_ATTRIBUTE_NORMAL;
            rep->output_buffer = info;
            rep->output_buffer_length = sizeof(*info);
            return 0;
        }
        default:
            rep->output_buffer_length = 0;
            rep->output_buffer = NULL;
            return 0;
        }

    case SMB2_0_INFO_FILESYSTEM:
        switch (req->file_info_class) {
        case SMB2_FILE_FS_SIZE_INFORMATION: {
            struct smb2_file_fs_size_info *info = calloc(1, sizeof(*info));
            if (!info) return -ENOMEM;
            info->total_allocation_units = 0x100000;
            info->available_allocation_units = 0x10000;
            info->sectors_per_allocation_unit = 1;
            info->bytes_per_sector = 512;
            rep->output_buffer = info;
            rep->output_buffer_length = sizeof(*info);
            return 0;
        }
        case SMB2_FILE_FS_DEVICE_INFORMATION: {
            struct smb2_file_fs_device_info *info = calloc(1, sizeof(*info));
            if (!info) return -ENOMEM;
            info->device_type = FILE_DEVICE_DISK;
            info->characteristics = 0;
            rep->output_buffer = info;
            rep->output_buffer_length = sizeof(*info);
            return 0;
        }
        case SMB2_FILE_FS_ATTRIBUTE_INFORMATION: {
            struct smb2_file_fs_attribute_info *info = calloc(1, sizeof(*info));
            if (!info) return -ENOMEM;
            info->filesystem_attributes = 0x02;
            info->maximum_component_name_length = 0x100;
            info->filesystem_name = (const uint8_t *)"FAT32";
            info->filesystem_name_length = 5;
            rep->output_buffer = info;
            rep->output_buffer_length = sizeof(*info);
            return 0;
        }
        default:
            rep->output_buffer_length = 0;
            rep->output_buffer = NULL;
            return 0;
        }

    default:
        rep->output_buffer_length = 0;
        rep->output_buffer = NULL;
        return 0;
    }
}

static int set_info_cmd(struct smb2_server *srvr, struct smb2_context *smb2,
                        struct smb2_set_info_request *req) {
    LOGI("set_info_cmd: info_type=%d file_info_class=%d",
         req->info_type, req->file_info_class);

    if (req->info_type == SMB2_0_INFO_FILE &&
        req->file_info_class == SMB2_FILE_DISPOSITION_INFORMATION &&
        req->input_data) {
        struct smb2_file_disposition_info *di = req->input_data;
        int idx;
        file_id_to_idx(req->file_id, &idx);
        if (idx >= 0 && idx < MAX_HANDLES && handle_table.handles[idx].used) {
            handle_table.handles[idx].delete_on_close = di->delete_pending;
            LOGI("set_info_cmd: delete_on_close=%d for idx=%d",
                 di->delete_pending, idx);
        }
    }
    return 0;
}

static struct smb2_server_request_handlers server_handlers = {
    NULL,
    authorize_user,
    session_established,
    logoff_cmd,
    tree_connect_cmd,
    tree_disconnect_cmd,
    create_cmd,
    close_cmd,
    flush_cmd,
    read_cmd,
    write_cmd,
    NULL,
    NULL,
    lock_cmd,
    ioctl_cmd,
    cancel_cmd,
    echo_cmd,
    query_directory_cmd,
    NULL,
    query_info_cmd,
    set_info_cmd
};

static void on_new_client(struct smb2_context *smb2, void *cb_data) {
    LOGI("New SMB2 client connected: %p", smb2);
    smb2_set_version(smb2, SMB2_VERSION_ANY);
    pthread_mutex_lock(&stats_mutex);
    connection_count++;
    pthread_mutex_unlock(&stats_mutex);
}

static void *server_thread_func(void *arg) {
    LOGI("Server thread started on port %d", server_port);
    server_running = 1;

    int serve_err = smb2_serve_port(&server, 1, on_new_client, NULL);
    if (serve_err) {
        LOGI("smb2_serve_port returned: %d", serve_err);
    }

    if (server.fd >= 0) {
        close(server.fd);
        server.fd = -1;
    }
    server_running = 0;
    LOGI("Server thread exiting");
    return NULL;
}

static void mark_transfer_cancelled(const char *real_path) {
    const char *name_only = strrchr(real_path, '/');
    name_only = name_only ? name_only + 1 : real_path;

    pthread_mutex_lock(&transfer_history.mutex);
    for (int i = transfer_history.count - 1; i >= 0; i--) {
        if (transfer_history.entries[i].status == 1 &&
            strcmp(transfer_history.entries[i].file_name, name_only) == 0) {
            transfer_history.entries[i].status = 2;
            break;
        }
    }
    pthread_mutex_unlock(&transfer_history.mutex);
}

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void *reserved) {
    LOGI("JNI_OnLoad called");
    memset(&handle_table, 0, sizeof(handle_table));
    pthread_mutex_init(&handle_table.mutex, NULL);
    memset(&transfer_history, 0, sizeof(transfer_history));
    pthread_mutex_init(&transfer_history.mutex, NULL);
    return JNI_VERSION_1_6;
}

JNIEXPORT jint JNICALL
Java_com_example_android_architecture_blueprints_anishelf_Smb2Server_nativeStart(
    JNIEnv *env, jclass cls, jint port, jstring share_name_j, jstring share_path_j) {

    if (server_running) {
        LOGI("Server already running");
        return -1;
    }

    const char *sn = (*env)->GetStringUTFChars(env, share_name_j, NULL);
    const char *sp = (*env)->GetStringUTFChars(env, share_path_j, NULL);

    strncpy(share_name, sn, sizeof(share_name) - 1);
    strncpy(share_path, sp, sizeof(share_path) - 1);
    share_name[sizeof(share_name) - 1] = '\0';
    share_path[sizeof(share_path) - 1] = '\0';

    (*env)->ReleaseStringUTFChars(env, share_name_j, sn);
    (*env)->ReleaseStringUTFChars(env, share_path_j, sp);

    server_port = port;
    connection_count = 0;
    bytes_written = 0;

    memset(&server, 0, sizeof(server));
    server.handlers = &server_handlers;
    server.signing_enabled = 0;
    server.allow_anonymous = 1;
    server.port = port;
    snprintf(server.hostname, sizeof(server.hostname), "AniShelf");

    if (pthread_create(&server_thread, NULL, server_thread_func, NULL) != 0) {
        LOGE("Failed to create server thread");
        return -1;
    }

    LOGI("nativeStart: share=%s path=%s port=%d", share_name, share_path, port);
    return 0;
}

JNIEXPORT void JNICALL
Java_com_example_android_architecture_blueprints_anishelf_Smb2Server_nativeStop(
    JNIEnv *env, jclass cls) {
    LOGI("nativeStop called");

    if (server_running) {
        server_running = 0;
        if (server.fd >= 0) {
            shutdown(server.fd, SHUT_RDWR);
        }
        pthread_join(server_thread, NULL);
        if (server.fd >= 0) {
            close(server.fd);
            server.fd = -1;
        }
    }

    pthread_mutex_lock(&handle_table.mutex);
    for (int i = 0; i < MAX_HANDLES; i++) {
        if (handle_table.handles[i].used) {
            if (handle_table.handles[i].fd >= 0) {
                close(handle_table.handles[i].fd);
            }
            memset(&handle_table.handles[i], 0, sizeof(struct file_handle));
        }
    }
    handle_table.count = 0;
    pthread_mutex_unlock(&handle_table.mutex);

    LOGI("Server stopped");
}

JNIEXPORT jboolean JNICALL
Java_com_example_android_architecture_blueprints_anishelf_Smb2Server_nativeIsRunning(
    JNIEnv *env, jclass cls) {
    return server_running ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jint JNICALL
Java_com_example_android_architecture_blueprints_anishelf_Smb2Server_nativeGetPort(
    JNIEnv *env, jclass cls) {
    return server_port;
}

JNIEXPORT jint JNICALL
Java_com_example_android_architecture_blueprints_anishelf_Smb2Server_nativeGetConnectionCount(
    JNIEnv *env, jclass cls) {
    int count;
    pthread_mutex_lock(&stats_mutex);
    count = connection_count;
    pthread_mutex_unlock(&stats_mutex);
    return count;
}

JNIEXPORT jlong JNICALL
Java_com_example_android_architecture_blueprints_anishelf_Smb2Server_nativeGetBytesWritten(
    JNIEnv *env, jclass cls) {
    long long written;
    pthread_mutex_lock(&stats_mutex);
    written = bytes_written;
    pthread_mutex_unlock(&stats_mutex);
    return (jlong)written;
}

JNIEXPORT jint JNICALL
Java_com_example_android_architecture_blueprints_anishelf_Smb2Server_nativeGetTransferCount(
    JNIEnv *env, jclass cls) {
    int count;
    pthread_mutex_lock(&transfer_history.mutex);
    count = transfer_history.count;
    pthread_mutex_unlock(&transfer_history.mutex);
    return count;
}

JNIEXPORT jstring JNICALL
Java_com_example_android_architecture_blueprints_anishelf_Smb2Server_nativeGetTransferFileName(
    JNIEnv *env, jclass cls, jint index) {
    pthread_mutex_lock(&transfer_history.mutex);
    const char *name = "";
    if (index >= 0 && index < transfer_history.count) {
        name = transfer_history.entries[index].file_name;
    }
    jstring result = (*env)->NewStringUTF(env, name);
    pthread_mutex_unlock(&transfer_history.mutex);
    return result;
}

JNIEXPORT jlong JNICALL
Java_com_example_android_architecture_blueprints_anishelf_Smb2Server_nativeGetTransferBytes(
    JNIEnv *env, jclass cls, jint index) {
    uint64_t bytes = 0;
    pthread_mutex_lock(&transfer_history.mutex);
    if (index >= 0 && index < transfer_history.count) {
        bytes = transfer_history.entries[index].total_bytes;
    }
    pthread_mutex_unlock(&transfer_history.mutex);
    return (jlong)bytes;
}

JNIEXPORT jint JNICALL
Java_com_example_android_architecture_blueprints_anishelf_Smb2Server_nativeGetTransferStatus(
    JNIEnv *env, jclass cls, jint index) {
    int status = 0;
    pthread_mutex_lock(&transfer_history.mutex);
    if (index >= 0 && index < transfer_history.count) {
        status = transfer_history.entries[index].status;
    }
    pthread_mutex_unlock(&transfer_history.mutex);
    return status;
}

JNIEXPORT void JNICALL
Java_com_example_android_architecture_blueprints_anishelf_Smb2Server_nativeClearTransfers(
    JNIEnv *env, jclass cls) {
    pthread_mutex_lock(&transfer_history.mutex);
    transfer_history.count = 0;
    pthread_mutex_unlock(&transfer_history.mutex);
}
