# 🚀 Self-Updater

An automatic **GitHub/GitLab-based updater** for your PM2 or Docker services.
It monitors your repository’s main branch and automatically pulls new commits and restarts your service.

## ✨ Features

- 🔁 Watches GitHub or GitLab repositories
- ⚙️ Supports both **PM2** and **Docker**
- 🕐 Configurable check interval
- 🧩 Easy CLI setup (`self-updater init`)
- 🧠 Runs continuously and self-manages

## 🧰 Installation

```bash
npm install -g self-updater
```

## ⚙️ CLI Commands
**1️⃣ Initialize Configuration**

```bash
self-updater init \
  --repo https://github.com/youruser/yourrepo.git \
  --branch main \
  --path /var/www/app \
  --type pm2 \
  --name my-service \
  --interval 60
```

| Option      | Description                                              |
|-------------|----------------------------------------------------------|
| ```--repo```      | GitHub or GitLab repository URL                          |
| ```--branch```    | Branch to watch (default: ```main```)                          |
| ```--path```      | Local path where the repository is located               |
| ```--type```      | ```pm2``` or ```docker```                                            |
| ```--name```      | Name of your PM2 or Docker instance                      |
| ```--interval```  | Interval in seconds between checks (default: ```60```)         |

A configuration file ```updater.config.json``` will be created.

**2️⃣ Start the Updater**

```bash
self-updater start
```

The updater will:
1. Check your repository regularly.
2. Detect new commits.
3. Pull changes into your local path.
4. Restart your PM2 or Docker service automatically.

## 🔍 Example Output
```bash
🔍 Watching https://github.com/youruser/yourrepo.git [main]...
📥 New commit detected → Updating and restarting service!
PM2 restarted: [my-service]
```

## 🧱 Project Structure

```python
self-updater/
├── bin/
│   └── cli.js
├── src/
│   ├── config.ts
│   ├── watcher.ts
│   ├── updater.ts
│   └── index.ts
├── scripts/
│   └── set-exec.js
├── package.json
├── tsconfig.json
└── README.md
```

## 🧩 Build

```bash
npm install
npm run build
```

Then test locally:

```bash
npm link
self-updater --help
```

## 🚀 Publish to npm
```bash
npm login
npm run build
npm publish --access public
```

## 🧠 License
Apache 2.0 License © 2025 VectoDE

## 💬 Support
Open an issue or feature request at
👉 https://github.com/VectoDE/self-updater/issues