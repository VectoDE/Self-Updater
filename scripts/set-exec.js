const fs = require("fs");
const path = require("path");

const cliPath = path.resolve("bin", "cli.js");

// Only make the binary executable on non-Windows systems
if (process.platform !== "win32") {
    fs.chmodSync(cliPath, "755");
    console.log("✅ CLI binary made executable:", cliPath);
} else {
    console.log("ℹ️ Windows detected – skipping chmod.");
}
