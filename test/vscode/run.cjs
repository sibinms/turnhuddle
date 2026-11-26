#!/usr/bin/env node
// Live integration run. Launches an isolated VS Code (own user-data and extensions directories) as an
// Extension Development Host, drives Turnhuddle through its commands (see suite.cjs) and exits non-zero on failure.
// This calls the real Claude Code and Codex CLIs and incurs their usage charges. macOS only.
//
// Environment:
//   TURNHUDDLE_CLAUDE_PATH / TURNHUDDLE_CODEX_PATH  executables written to the isolated settings (default: claude / codex)
//   TURNHUDDLE_TIMEOUT_SECONDS                      per-turn timeout for the run (default 600)
//   TURNHUDDLE_VSIX                                 when set, install this VSIX into the isolated extensions directory and
//                                                   drive the installed extension (a tiny driver extension hosts the suite)
//   TURNHUDDLE_WORK_DIR                             where the isolated directories and report.json are created (default: os.tmpdir(); keep it short)
//   VSCODE_APP                                      VS Code application bundle (default: /Applications/Visual Studio Code.app)
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..', '..');
const app = process.env.VSCODE_APP || '/Applications/Visual Studio Code.app';
const plist = path.join(app, 'Contents', 'Info.plist');
if (!fs.existsSync(plist)) { console.error(`VS Code not found at ${app}. Set VSCODE_APP.`); process.exit(2); }
const executableName = (fs.readFileSync(plist, 'utf8').match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/) || [])[1] || 'Code';
const electron = path.join(app, 'Contents', 'MacOS', executableName);
const workDir = fs.mkdtempSync(path.join(process.env.TURNHUDDLE_WORK_DIR || os.tmpdir(), 'th-vscode-'));
const userDataDir = path.join(workDir, 'user-data');
// VS Code listens on a Unix socket inside user-data-dir; macOS limits socket paths to 104 bytes.
if (userDataDir.length > 85) { console.error(`Work directory path is too long for VS Code's socket (${userDataDir.length} chars): ${userDataDir}. Set TURNHUDDLE_WORK_DIR to a shorter path.`); process.exit(2); }
const extensionsDir = path.join(workDir, 'extensions');
const workspace = path.join(workDir, 'workspace');
const report = path.join(workDir, 'report.json');
for (const dir of [path.join(userDataDir, 'User'), extensionsDir, workspace]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(workspace, 'README.md'), '# Turnhuddle test workspace\n\nDisposable folder used by test/vscode/run.cjs.\n');
fs.writeFileSync(path.join(userDataDir, 'User', 'settings.json'), JSON.stringify({
  'turnhuddle.claudePath': process.env.TURNHUDDLE_CLAUDE_PATH || 'claude',
  'turnhuddle.codexPath': process.env.TURNHUDDLE_CODEX_PATH || 'codex',
  'turnhuddle.timeoutSeconds': Number(process.env.TURNHUDDLE_TIMEOUT_SECONDS || 600),
  // Most steps assert the exact three-turn relay; the suite switches to agreement mode for its own step.
  'turnhuddle.roundMode': 'fixed',
  // The suite runs the update check itself; the automatic one would only add a notification.
  'turnhuddle.checkForUpdates': false,
  'update.mode': 'none',
  'telemetry.telemetryLevel': 'off',
  'workbench.startupEditor': 'none'
}, null, 2));
const common = [`--user-data-dir=${userDataDir}`, `--extensions-dir=${extensionsDir}`, '--no-sandbox', '--disable-updates', '--skip-welcome', '--skip-release-notes'];
let developmentPath = root;
if (process.env.TURNHUDDLE_VSIX) {
  const vsix = path.resolve(process.env.TURNHUDDLE_VSIX);
  console.log(`Installing ${vsix} into ${extensionsDir}`);
  // Use VS Code's CLI launcher for installs: running the app binary with --install-extension does not reliably exit.
  const install = spawnSync(path.join(app, 'Contents', 'Resources', 'app', 'bin', 'code'), [`--user-data-dir=${userDataDir}`, `--extensions-dir=${extensionsDir}`, '--install-extension', vsix], { stdio: 'inherit' });
  if (install.status !== 0) process.exit(install.status ?? 1);
  developmentPath = path.join(workDir, 'driver');
  fs.mkdirSync(developmentPath);
  fs.writeFileSync(path.join(developmentPath, 'package.json'), JSON.stringify({ name: 'turnhuddle-driver', publisher: 'turnhuddle', version: '0.0.0', engines: { vscode: '^1.95.0' }, main: './extension.js' }));
  fs.writeFileSync(path.join(developmentPath, 'extension.js'), 'exports.activate = () => {};\n');
}
console.log(`Launching isolated VS Code (data in ${workDir})`);
const result = spawnSync(electron, [...common, `--extensionDevelopmentPath=${developmentPath}`, `--extensionTestsPath=${path.join(__dirname, 'suite.cjs')}`, '--disable-workspace-trust', workspace], {
  stdio: 'inherit',
  env: { ...process.env, TURNHUDDLE_REPORT: report, TURNHUDDLE_EXPECT_INSTALLED: process.env.TURNHUDDLE_VSIX ? '1' : '' }
});
console.log(`Report: ${report}`);
process.exit(result.status ?? 1);
