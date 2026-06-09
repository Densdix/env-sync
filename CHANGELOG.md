# Change Log

All notable changes to the "env-sync" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [1.0.0] - 2025-06-09

### Added
- 🔄 Real-time synchronization of `.env` files via Firebase Realtime Database (SSE).
- 🎨 Visual diff highlights for changed/new lines with auto-fade after 10 seconds.
- 📁 History sidebar panel with chronological list of modifications.
- ⚖️ Side-by-side diff comparison with historical database versions.
- 🏷️ Automatic project namespacing via Git remote origin URL.
- 👤 Author & host logging (Git email + device hostname).
- ♾️ Loop prevention via in-memory content cache and hostname checks.
- ☁️ Manual Pull File / Pull All commands from database.
