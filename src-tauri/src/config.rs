use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use windows::core::PCWSTR;
use windows::Win32::System::Registry::{
    RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegSetValueExW, HKEY_CURRENT_USER, KEY_SET_VALUE,
    REG_SZ,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HotkeyBinding {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub win_key: bool,
    pub key: String,
}

impl Default for HotkeyBinding {
    fn default() -> Self {
        Self {
            ctrl: false,
            alt: true,
            shift: false,
            win_key: false,
            key: "F2".into(),
        }
    }
}

impl HotkeyBinding {
    pub fn accelerator(&self) -> String {
        let mut parts: Vec<String> = Vec::new();
        if self.ctrl {
            parts.push("Ctrl".into());
        }
        if self.alt {
            parts.push("Alt".into());
        }
        if self.shift {
            parts.push("Shift".into());
        }
        if self.win_key {
            parts.push("Super".into());
        }
        parts.push(self.key.to_ascii_uppercase());
        parts.join("+")
    }

    pub fn valid(&self) -> bool {
        let key = self.key.to_ascii_uppercase();
        let valid_key = (key.len() == 1
            && key
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric()))
            || (key
                .strip_prefix('F')
                .and_then(|digits| digits.parse::<u8>().ok())
                .is_some_and(|n| (1..=24).contains(&n)));
        valid_key && (self.ctrl || self.alt || self.shift || self.win_key)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Config {
    pub hotkey: HotkeyBinding,
    pub save_directory: Option<String>,
    #[serde(default)]
    pub autostart: bool,
    #[serde(default)]
    pub theme: ThemeMode,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            hotkey: HotkeyBinding::default(),
            save_directory: None,
            autostart: false,
            theme: ThemeMode::System,
        }
    }
}

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE_NAME: &str = "PinShot";

impl Config {
    pub fn config_dir() -> PathBuf {
        std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("pin-shot")
    }

    pub fn config_path() -> PathBuf {
        Self::config_dir().join("config.json")
    }

    pub fn load() -> Self {
        let config = std::fs::read_to_string(Self::config_path())
            .ok()
            .and_then(|data| serde_json::from_str::<Self>(&data).ok())
            .unwrap_or_default();
        sync_autostart(config.autostart);
        let _ = config.save();
        config
    }

    pub fn save(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(Self::config_dir())?;
        let data = serde_json::to_vec_pretty(self)?;
        let path = Self::config_path();
        let temp = path.with_extension("json.tmp");
        std::fs::write(&temp, data)?;
        std::fs::rename(temp, path)
    }

    pub fn save_directory_path(&self) -> PathBuf {
        self.save_directory
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(default_save_directory)
    }

    pub fn set_autostart(&mut self, enabled: bool) {
        self.autostart = enabled;
        sync_autostart(enabled);
    }
}

pub fn default_save_directory() -> PathBuf {
    std::env::var("USERPROFILE")
        .map(|p| PathBuf::from(p).join("Desktop"))
        .unwrap_or_else(|_| PathBuf::from("."))
}

pub fn validate_save_directory(path: &Option<String>) -> Result<(), String> {
    let Some(value) = path.as_deref().map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(());
    };
    let path = Path::new(value);
    if !path.is_dir() {
        return Err("保存目录不存在或不是文件夹".into());
    }
    Ok(())
}

pub fn sync_autostart(enabled: bool) {
    let key = wide(RUN_KEY);
    let name = wide(VALUE_NAME);
    unsafe {
        if enabled {
            let Ok(exe) = std::env::current_exe() else {
                return;
            };
            let exe = wide(&format!("\"{}\"", exe.to_string_lossy()));
            let mut hkey = std::mem::zeroed();
            if RegOpenKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(key.as_ptr()),
                Some(0),
                KEY_SET_VALUE,
                &mut hkey,
            )
            .is_ok()
            {
                let _ = RegSetValueExW(
                    hkey,
                    PCWSTR(name.as_ptr()),
                    Some(0),
                    REG_SZ,
                    Some(std::slice::from_raw_parts(
                        exe.as_ptr() as *const u8,
                        exe.len() * 2,
                    )),
                );
                let _ = RegCloseKey(hkey);
            }
        } else {
            let mut hkey = std::mem::zeroed();
            if RegOpenKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(key.as_ptr()),
                Some(0),
                KEY_SET_VALUE,
                &mut hkey,
            )
            .is_ok()
            {
                let _ = RegDeleteValueW(hkey, PCWSTR(name.as_ptr()));
                let _ = RegCloseKey(hkey);
            }
        }
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}
