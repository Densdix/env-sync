# Env Sync — VS Code Extension

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![VS Code](https://img.shields.io/badge/VS%20Code-Extension-blue.svg)](https://marketplace.visualstudio.com/items?itemName=densdix.env-sync)

VS Code extension for automatic synchronization of `.env` files across developer devices in a monorepo and usual projects. It uses **Firebase Realtime Database** as a lightweight, real-time backend.

---

## Features

- 🔄 **Real-Time Sync:** When you save any `.env` file (e.g. `apps/api/.env`, `apps/web/.env`), it is pushed to the database. Other devices fetch the update instantly.
- 🎨 **Visual Diff Highlights:** Changed or newly added lines are highlighted directly in the editor using theme-native colors, fading out after 10 seconds or when you start typing.
- 📁 **History Sidebar Panel:** A dedicated view in the left explorer sidebar container listing all synced `.env` files and a chronological list of their modifications.
- ⚖️ **Side-by-Side Diff Comparing:** Click any historical version in the sidebar to open the native VS Code side-by-side diff comparing your local `.env` with the historical database version.
- 🏷️ **Automatic Namespacing:** Projects are identified dynamically by their Git Remote Origin URL (`git config --get remote.origin.url`). Projects on GitLab, GitHub, etc., are separated automatically and will not overwrite each other.
- 👤 **Author & Host Logging:** Every change in the database tracks the developer's Git email/username and device hostname (e.g., `user@domain.com (MacBook-Pro)`).
- ♾️ **Loop Prevention:** Uses an in-memory content cache and device hostname checks to prevent infinite save-and-download loops.

---

## 1. Firebase Realtime Database Setup (2 Minutes)

1. Go to the [Firebase Console](https://console.firebase.google.com/).
2. Click **Add project**, choose a name (e.g., `my-env-sync`), and click **Create project** (disable Google Analytics to speed it up).
3. In the left sidebar, click **Build** -> **Realtime Database** -> **Create Database**.
4. Select a location close to you, click **Next**, and select **Start in test mode** (which sets rules to public read/write).
5. Ensure the rules tab has public access configured (since data is not encrypted and security/credentials do not matter for this development setup):
   ```json
   {
     "rules": {
       ".read": true,
       ".write": true
     }
   }
   ```
6. Copy the database URL (looks like `https://your-db-default-rtdb.europe-west1.firebasedatabase.app/`).

---

## 2. VS Code Extension Configuration

Add the following to your global VS Code `settings.json` (or workspace-level `.vscode/settings.json` which is ignored in Git) on all your devices:

```json
{
  "envSync.databaseUrl": "https://your-db-default-rtdb.europe-west1.firebasedatabase.app/",
  "envSync.enabled": true
}
```

---

## 3. Database Schema

The extension automatically creates and reads the following JSON structure:

```json
{
  "env-sync": {
    "projects": {
      "github_com_username_my-project_git": {
        "files": {
          "apps_api_env": {
            "path": "apps/api/.env",
            "content": "API_URL=https://api.example.com\nPORT=3000\n",
            "updatedAt": 1780956058136,
            "updatedBy": "developer@example.com (MacBook-Pro)"
          }
        },
        "history": {
          "apps_api_env": {
            "-Nxxxxxxxxxxxx": {
              "path": "apps/api/.env",
              "content": "API_URL=https://api.example.com\nPORT=3000\n",
              "updatedAt": 1780956058136,
              "updatedBy": "developer@example.com (MacBook-Pro)"
            }
          }
        }
      }
    }
  }
}
```

---

## 4. Development & Compilation

To build and compile the extension locally:

```bash
# 1. Install required compiler/TypeScript dependencies
npm install

# 2. Compile TypeScript files into JavaScript
npm run compile
```

---

## 5. Local Debugging & Testing

1. Open this repository folder (`/env-sync`) in VS Code.
2. Press `F5` (or go to **Run and Debug** -> click **Run Extension**).
3. A new window named `[Extension Development Host]` will open.
4. In this new window, open your monorepo workspace (e.g. `my-project`) and ensure the database URL setting is configured.
5. Save a `.env` file or modify the database value to test updates.

---

## 6. Packaging & Installation (.vsix)

To package the extension into an installer you can share or install on another laptop:

```bash
# Compile and package into a .vsix archive
npm run vsix
```

This generates `env-sync-1.0.0.vsix` in the root folder.

### To Install:
* **Via command line:**
  ```bash
  code --install-extension env-sync-1.0.0.vsix
  ```
* **Via VS Code UI:** Go to **Extensions** (`Cmd+Shift+X`), click the three dots (`...`) in the top right, select **Install from VSIX...**, and choose the `.vsix` file.

---

## License

This project is licensed under the [MIT License](LICENSE).
