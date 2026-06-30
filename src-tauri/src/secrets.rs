// Secret-at-rest for API_TOKEN.
//
// Threat model: single-user desktop. We avoid plaintext on disk and resist
// casual exfiltration (someone copying app_local_data_dir or pushing it to a
// repo). We do NOT defend against an attacker with full code execution as the
// current OS user — that's out of scope for an app that needs to read its own
// token at startup.
//
// Approach: HKDF-SHA256(machine_seed || hostname || salt) -> 32-byte AES-256
// key, AES-256-GCM with a fresh 12-byte nonce per write. File layout:
//   [1 byte version] [12 byte nonce] [ciphertext..]

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use anyhow::{anyhow, Context, Result};
use hkdf::Hkdf;
use sha2::Sha256;
use std::fs;
use std::path::PathBuf;

const VERSION: u8 = 1;
const FILE_NAME: &str = "secrets.bin";
const SEED_NAME: &str = "device.seed";
const SALT: &[u8] = b"notebookpi-token-v1";

fn seed_path(dir: &PathBuf) -> PathBuf {
    dir.join(SEED_NAME)
}

fn token_path(dir: &PathBuf) -> PathBuf {
    dir.join(FILE_NAME)
}

fn load_or_create_seed(dir: &PathBuf) -> Result<Vec<u8>> {
    fs::create_dir_all(dir).ok();
    let p = seed_path(dir);
    if p.exists() {
        let bytes = fs::read(&p).context("read device seed")?;
        if bytes.len() >= 16 {
            return Ok(bytes);
        }
    }
    let mut buf = [0u8; 32];
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut buf);
    fs::write(&p, buf).context("write device seed")?;
    Ok(buf.to_vec())
}

fn derive_key(dir: &PathBuf) -> Result<[u8; 32]> {
    let seed = load_or_create_seed(dir)?;
    let host = hostname::get()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "unknown-host".to_string());
    let user = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "user".to_string());

    let mut ikm = Vec::with_capacity(seed.len() + host.len() + user.len() + 1);
    ikm.extend_from_slice(&seed);
    ikm.push(b'|');
    ikm.extend_from_slice(host.as_bytes());
    ikm.push(b'|');
    ikm.extend_from_slice(user.as_bytes());

    let hk = Hkdf::<Sha256>::new(Some(SALT), &ikm);
    let mut okm = [0u8; 32];
    hk.expand(b"aes-256-gcm-token", &mut okm)
        .map_err(|e| anyhow!("hkdf expand: {e}"))?;
    Ok(okm)
}

fn cipher(dir: &PathBuf) -> Result<Aes256Gcm> {
    let key_bytes = derive_key(dir)?;
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
    Ok(Aes256Gcm::new(key))
}

pub fn save_token(dir: &PathBuf, token: &str) -> Result<()> {
    fs::create_dir_all(dir).ok();
    let cipher = cipher(dir)?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ct = cipher
        .encrypt(&nonce, token.as_bytes())
        .map_err(|e| anyhow!("encrypt: {e}"))?;

    let mut out = Vec::with_capacity(1 + 12 + ct.len());
    out.push(VERSION);
    out.extend_from_slice(nonce.as_slice());
    out.extend_from_slice(&ct);
    fs::write(token_path(dir), out).context("write secrets.bin")?;
    Ok(())
}

pub fn read_token(dir: &PathBuf) -> Result<Option<String>> {
    let p = token_path(dir);
    if !p.exists() {
        return Ok(None);
    }
    let blob = fs::read(&p).context("read secrets.bin")?;
    if blob.len() < 1 + 12 + 16 {
        return Err(anyhow!("secrets.bin too short"));
    }
    if blob[0] != VERSION {
        return Err(anyhow!("secrets.bin unknown version: {}", blob[0]));
    }
    let nonce = Nonce::from_slice(&blob[1..13]);
    let ct = &blob[13..];
    let cipher = cipher(dir)?;
    let pt = cipher
        .decrypt(nonce, ct)
        .map_err(|e| anyhow!("decrypt: {e}"))?;
    Ok(Some(String::from_utf8(pt).context("utf8 token")?))
}

pub fn clear_token(dir: &PathBuf) -> Result<()> {
    let p = token_path(dir);
    if p.exists() {
        fs::remove_file(p).context("remove secrets.bin")?;
    }
    Ok(())
}

pub fn has_token(dir: &PathBuf) -> bool {
    token_path(dir).exists()
}
