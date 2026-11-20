#ifndef UNICODE
#define UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wchar.h>

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR args, int show) {
    (void) instance;
    (void) previous;
    (void) show;
    wchar_t folder[MAX_PATH];
    const DWORD length = GetModuleFileNameW(NULL, folder, MAX_PATH);
    if (!length || length >= MAX_PATH) return 2;
    wchar_t *last = wcsrchr(folder, L'\\');
    if (!last) return 2;
    *last = 0;
    wchar_t node[MAX_PATH], line[2 * MAX_PATH + 100];
    if (swprintf(node, MAX_PATH, L"%ls\\runtime\\node.exe", folder) < 0 ||
        swprintf(line, 2 * MAX_PATH + 100, L"\"%ls\" \"%ls\\native\\host.mjs\"%ls",
            node, folder, wcscmp(args, L"--self-check") == 0 ? L" --self-check" : L"") < 0) return 2;
    STARTUPINFOW startup = { .cb = sizeof(startup), .dwFlags = STARTF_USESTDHANDLES };
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    PROCESS_INFORMATION child;
    if (!CreateProcessW(node, line, NULL, NULL, TRUE, CREATE_NO_WINDOW, NULL, folder, &startup, &child)) return 3;
    WaitForSingleObject(child.hProcess, INFINITE);
    DWORD code = 4;
    GetExitCodeProcess(child.hProcess, &code);
    CloseHandle(child.hThread);
    CloseHandle(child.hProcess);
    return (int) code;
}
