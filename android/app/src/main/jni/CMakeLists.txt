cmake_minimum_required(VERSION 3.22.1)
project("smb2android" LANGUAGES C)

add_subdirectory(libsmb2)

add_library(smb2_server_jni SHARED
    smb2_server_jni.c
)

target_compile_definitions(smb2_server_jni PRIVATE
    ANDROID
    HAVE_CONFIG_H
    NEED_GETLOGIN_R
)

target_include_directories(smb2_server_jni PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/libsmb2/include
    ${CMAKE_CURRENT_SOURCE_DIR}/libsmb2/include/smb2
    ${CMAKE_CURRENT_BINARY_DIR}/libsmb2
)

target_link_libraries(smb2_server_jni
    smb2
    log
)

set_target_properties(smb2_server_jni PROPERTIES
    VERSION 1.0.0
)
