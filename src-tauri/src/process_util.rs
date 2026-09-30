use std::process::{Child, Command};

pub fn spawn_detached(command: &mut Command) -> std::io::Result<()> {
    let child = command.spawn()?;
    reap_in_background(child);
    Ok(())
}

pub fn reap_in_background(mut child: Child) {
    std::thread::spawn(move || {
        let _ = child.wait();
    });
}

pub fn kill_and_wait(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}
