//! Instance-specific update receipt; this is not itself a health verdict.
use std::{env, fs, path::PathBuf};

pub fn publish(port: u16) -> Result<(), String> {
    let nonce = match env::var("GA_HUB_UPDATE_NONCE") {
        Ok(value) if value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()) => value,
        _ => return Ok(()),
    };
    let path = PathBuf::from(env::var("GA_HUB_UPDATE_RECEIPT").map_err(|e| e.to_string())?);
    if !path.is_absolute() { return Err("Receipt path must be absolute".into()); }
    let parent = path.parent().ok_or("Receipt has no parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let data = serde_json::json!({
        "nonce": nonce, "pid": std::process::id(), "port": port,
        "executable": env::current_exe().map_err(|e| e.to_string())?,
    });
    let temp = path.with_extension("tmp");
    fs::write(&temp, serde_json::to_vec(&data).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    fs::rename(temp, path).map_err(|e| e.to_string())
}
