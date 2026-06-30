// NotebookPi desktop entry point.
//
// Windows hides the console window in release builds. Logging still goes to
// stderr/file; for dev runs (`tauri dev`) Tauri swaps in an attached console.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    notebook_pi_desktop_lib::run()
}
