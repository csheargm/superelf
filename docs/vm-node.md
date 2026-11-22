# Run superelf in a Linux VM on a Windows PC (isolation layer) · 在 Windows 电脑的 Linux 虚拟机中运行（隔离层）

## Why · 为什么

superelf's agent is powerful on purpose: the owner's lane runs Claude Code with
`--dangerously-skip-permissions` (`lib/config.mjs`), so it can read, write and run anything its
user can. On a family Windows PC that means the family's files, browser profiles, saved
credentials and every device on the home network.

A **virtual machine（虚拟机, VM）** is the **blast-radius boundary（爆炸半径边界）**: the agent
gets a whole computer, and that computer has nothing in it but superelf.

**What the VM does NOT protect（虚拟机不保护的）:**

- **The family data inside superelf itself** — conversations, journal, health records, notes,
  `config.json` (API keys, password hashes). The agent can read all of it, by design.
- **The accounts signed in inside the VM** — Claude, Codex.
- **The internet.** The VM must reach Claude/Codex/npm, so a misbehaving agent can still send data
  out. The VM stops it reaching *your other machines*, not the outside world.
- **A hypervisor escape（虚拟机逃逸）** — rare, but real. Keep Windows and the hypervisor updated.

## Hypervisor · 虚拟机软件

| Windows edition | Use | Start the VM at boot（开机自启） |
|---|---|---|
| Pro / Enterprise / Education | **Hyper-V** (built in) | VM setting **Automatic Start Action** |
| Home | **VirtualBox** or **VMware Workstation Pro** (free for personal use) | a Task Scheduler task at startup |

**Hyper-V** (PowerShell as Administrator; reboot after enabling):

```powershell
Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -All

New-VM -Name superelf -Generation 2 -MemoryStartupBytes 8GB -SwitchName "Default Switch" `
  -NewVHDPath "C:\VMs\superelf.vhdx" -NewVHDSizeBytes 40GB
Set-VMProcessor -VMName superelf -Count 4
Set-VMMemory -VMName superelf -DynamicMemoryEnabled $false
# Ubuntu boots under Secure Boot only with the "Microsoft UEFI Certificate Authority" template.
Set-VMFirmware -VMName superelf -SecureBootTemplate MicrosoftUEFICertificateAuthority
# Windows 10/11 turns on automatic checkpoints for new VMs: one per boot, each growing a disk for
# the whole uptime, and restoring one by mistake rolls the family's data back. Take checkpoints by hand.
Set-VM -Name superelf -AutomaticCheckpointsEnabled $false
Add-VMDvdDrive -VMName superelf -Path "C:\ISO\<ubuntu-live-server-amd64>.iso"
Set-VMFirmware -VMName superelf -FirstBootDevice (Get-VMDvdDrive -VMName superelf)
# Start with Windows (no one needs to sign in), shut down cleanly with it.
Set-VM -Name superelf -AutomaticStartAction Start -AutomaticStartDelay 30 -AutomaticStopAction ShutDown
```

"Default Switch" is Hyper-V's built-in **NAT** switch — what you want (see the checklist).

**VirtualBox / VMware on Windows Home.** Their command-line tools may not be on PATH: in each
PowerShell window where you use one from this guide, first run (harmless if they resolve already):

```powershell
Set-Alias VBoxManage "C:\Program Files\Oracle\VirtualBox\VBoxManage.exe"            # VirtualBox
Set-Alias vmrun "C:\Program Files (x86)\VMware\VMware Workstation\vmrun.exe"        # VMware
```

Create the VM in the GUI with the sizes below and a **NAT** network adapter. To start it at boot,
create a task in **Task Scheduler** — trigger *At startup*, *Run whether user is logged on or
not*, run as **the Windows user who created the VM** (VirtualBox VMs belong to that user) — whose
action is:

- VirtualBox: `"C:\Program Files\Oracle\VirtualBox\VBoxManage.exe"` with arguments
  `startvm superelf --type headless`
- VMware: `"C:\Program Files (x86)\VMware\VMware Workstation\vmrun.exe"` with arguments
  `-T ws start "C:\VMs\superelf\superelf.vmx" nogui` (check the install path on your machine; some
  Workstation versions also offer a built-in auto-start option)

A VM started this way may not be shut down cleanly when Windows restarts. Before a planned reboot:
`VBoxManage controlvm superelf acpipowerbutton` (VirtualBox) or
`vmrun -T ws stop "C:\VMs\superelf\superelf.vmx" soft` (VMware).

On every host: Windows must **never sleep on AC** — `powercfg /change standby-timeout-ac 0`.
A sleeping host is an offline node.

## VM size · 虚拟机规格

**2–4 vCPU, 4–8 GB RAM, 40 GB disk.** superelf is light; the RAM is for Claude Code / Codex
sessions running in parallel. Use fixed (not dynamic) memory on Hyper-V.

## Ubuntu Server LTS · 安装系统

Install the current **Ubuntu Server LTS**. In the storage step keep "Use an entire disk", and leave
**"Encrypt the LVM group with LUKS" UNTICKED（不要勾选全盘加密）**. A full-disk-encryption
passphrase is asked for at every boot, on a console nobody is watching: the VM would sit at the
prompt after every Windows Update reboot, and superelf would be down until someone typed it.
Protect the disk at rest from the outside instead — **BitLocker** on the Windows host encrypts the
VM's disk file with everything else.

Do **not** install the hypervisor's guest tools (VirtualBox Guest Additions etc.): shared folders,
the shared clipboard and drag-and-drop all depend on them.

## Isolation checklist · 隔离清单

| | Setting | Why |
|---|---|---|
| ☐ | **No shared folders（无共享文件夹）** | a shared folder is a path straight back into Windows |
| ☐ | **Clipboard and drag-and-drop off（关闭剪贴板/拖放）** | the agent must not read what you copy on the host |
| ☐ | **NAT networking, not bridged（NAT，不要桥接）** | bridged puts the VM *on* the home LAN; NAT puts it behind the host |
| ☐ | **No USB passthrough（不直通 USB）** | no phones, drives or keys plugged into the agent's machine |

- **Hyper-V:** no shared folders exist by default; keep **Enhanced Session Mode** off
  (`Set-VMHost -EnableEnhancedSessionMode $false`) — it is what carries clipboard and drives into a
  VM — and the copy-files service off:
  `Disable-VMIntegrationService -VMName superelf -Name "Guest Service Interface"`.
  Hyper-V has no general USB passthrough.
- **VirtualBox 7.x** (6.1 spells some options without hyphens, e.g. `--draganddrop`; if one is
  rejected, check `VBoxManage modifyvm --help`):

  ```powershell
  VBoxManage modifyvm superelf --nic1 nat --clipboard-mode disabled --drag-and-drop disabled `
    --usb-ohci off --usb-ehci off --usb-xhci off
  VBoxManage showvminfo superelf     # "Shared folders:" must list none
  ```

- **VMware Workstation:** VM Settings → Options → **Shared Folders: Disabled**; Options →
  **Guest Isolation**: untick drag-and-drop and copy-and-paste; Hardware → Network Adapter: **NAT**;
  remove the **USB Controller**.

## Firewall inside the VM · 虚拟机内防火墙（ufw）

NAT keeps the home network from reaching the VM. This keeps the VM from reaching the home network:
**deny outbound to private LAN ranges（禁止出站到内网网段）**, allow the internet.

Rules are matched in order, so the allows come first:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow in on tailscale0                 # who may connect is decided by Tailscale ACLs below
sudo ufw allow out to any port 53               # DNS — by port, NOT by address (see below)
sudo ufw allow out proto udp to any port 67     # DHCP lease renewal
sudo ufw deny out to 10.0.0.0/8
sudo ufw deny out to 172.16.0.0/12
sudo ufw deny out to 192.168.0.0/16
sudo ufw deny out to 169.254.0.0/16
sudo ufw deny out to fc00::/7                   # private IPv6 (ULA)
sudo ufw enable
sudo ufw status numbered
```

**Why DNS by port（DNS 按端口放行）:** the VM's DNS server is usually the NAT gateway, and Hyper-V's
"Default Switch" picks a **new subnet every time Windows boots**. A rule pinned to today's address
blocks every lookup after the next reboot, and every agent turn fails while the node looks healthy.
The cost: the VM can reach port 53, and only that, on LAN devices.

Tailscale's own range (`100.64.0.0/10`) is **not** in that list: it is Tailscale's to police, with
the ACL below. A side effect worth knowing: Tailscale cannot make *direct* connections to devices
on your LAN's private addresses, so traffic from home phones may go through a Tailscale relay
（中继）. It still works; it is slightly slower.

Check now, **and again after the first Windows restart（Windows 重启后再查一次）**:

```bash
resolvectl query api.anthropic.com      # resolves
curl -sI https://api.anthropic.com      # answers
curl -m 5 http://<your router's IP>     # times out (router IP: "Default Gateway" in Windows ipconfig)
```

## Tailscale · 远程访问（tagged node）

The VM joins your tailnet as a **tagged node（带标签的节点） `tag:superelf`**: it belongs to the
tailnet, not to a person, its key does not expire, and the ACL can say exactly who reaches it.

1. In the Tailscale admin console, **Access controls**, add the tag and the rules. Tailscale denies
   anything not allowed, so the VM reaches nothing because no rule has it as a source:

   ```jsonc
   {
     "groups":    { "group:family": ["you@example.com", "partner@example.com"] },
     "tagOwners": { "tag:superelf": ["autogroup:admin"] },
     "acls": [
       // family devices -> superelf's HTTPS port, and nothing else on it
       { "action": "accept", "src": ["group:family"], "dst": ["tag:superelf:443"] }
       // your other rules — but NONE with "tag:superelf" or "*" as src
     ]
   }
   ```

   The default policy's allow-all rule (`"src": ["*"], "dst": ["*:*"]`) must go: `*` includes
   tagged devices, so it would let the VM reach every machine on the tailnet. (Newer policies can
   say the same with `grants`; either works.)
2. In **DNS**, turn on MagicDNS and **HTTPS Certificates** (needed for `tailscale serve`).
   The certificate puts the machine name and tailnet name in public certificate-transparency logs:
   name the VM something neutral (not a person, not a family name) before this step.
3. In the VM:

   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up --advertise-tags=tag:superelf
   sudo tailscale serve --bg --https=443 8787      # tailnet only; survives reboots
   tailscale serve status                          # must say "(tailnet only)"
   ```

   superelf listens on `127.0.0.1` by default (`bind_host`), so `tailscale serve` is the only way
   in — nothing on the VM's other interfaces answers. Leave `bind_host` unset here. If you set up
   the owner in the browser rather than with `node setup.mjs`, the form asks for the one-time
   setup code: `cat ~/superelf/setup-code` (or read it in `journalctl --user -u superelf-web`).

**Never `tailscale funnel`（不要用 Funnel）** — that publishes superelf to the whole internet.
Family opens `https://<vm-name>.<tailnet>.ts.net`.

### Do the rest over SSH, temporarily · 之后临时用 SSH 操作

With the clipboard off and no guest tools, the console cannot copy text out or paste it in, and the
next steps need a key pasted into GitHub and a long Claude sign-in URL. So, for setup only:

1. In the ACL add a **temporary** rule
   `{ "action": "accept", "src": ["you@example.com"], "dst": ["tag:superelf:22"] }`.
2. At the VM console: `sudo apt-get install -y openssh-server`.
3. From your own computer on the tailnet: `ssh <vm-user>@<vm-name>`, with the VM user's password.
4. When setup **and** moving data in (below) are done, **remove the rule（删除临时规则）**. Then nothing
   reaches port 22: the tailnet ACL stops it, and ufw already stops the LAN.

## Install superelf in the VM · 安装

```bash
sudo apt-get update && sudo apt-get install -y git curl
# Node 22+: Ubuntu's own nodejs package is older than package.json's floor.
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
curl -fsSL https://claude.ai/install.sh | bash     # Claude Code → ~/.local/bin/claude
sudo npm i -g @openai/codex                        # only if you use the GPT (Codex) lane
exec $SHELL -l                                     # pick up the new PATH
```

**Moving from another node?** Put its data in **before** the first `./install.sh` — see
[Moving data in](#moving-data-in-retiring-the-old-node--迁移并停用旧节点).

Clone with the read-only deploy key (next section), then `cd superelf && ./install.sh`. On Linux
it installs a **systemd user service（用户服务）** `superelf-web` and turns on **linger** so it
starts at boot with nobody logged in. Then `claude` once, and sign in.

| | |
|---|---|
| start / stop | `./start.sh` / `./stop.sh` |
| update（更新） | **snapshot first** (below), then `./deploy.sh` — see [Updating](#updating--更新部署) |
| status | `systemctl --user status superelf-web` |
| logs（日志） | `journalctl --user -u superelf-web -f` |

## Updating · 更新部署

Take a **snapshot（快照）** first (next sections) — the VM cannot snapshot itself — and deploy only
commits that are **green in CI（CI 通过）**. Then, in the VM:

```bash
cd ~/superelf
./deploy.sh --dry-run     # what would be deployed; changes nothing
./deploy.sh               # fetch, fast-forward, syntax check, ./install.sh, health check
```

`deploy.sh` refuses, changing nothing, unless the checkout is on `main`, has **no tracked
modifications**, no other `deploy.sh` is running (a lock), and the `superelf-web` unit is installed
and reachable. It only fast-forwards to `origin/main` (never merges), and refuses if that would
start tracking a path that already exists here (an **ignored, node-only file（仅本节点的被忽略文件）**
it would overwrite). It checks that every server file parses, re-runs `./install.sh` (which restarts
the service), then waits up to ~45 s for the unit to be active **and** `http://127.0.0.1:<port>/`
to answer 200, eight probes in a row from the same process. Unhealthy: it prints the last 40
journal lines, **rolls back（回滚）** to the commit it started from (`git reset --keep`, so an edit
made meanwhile is kept, never discarded), re-installs and checks again — exit 1. **Exit 3**: the
rollback could not be done (it says why, and lists what to save) or is unhealthy too — **restore
the snapshot**.

**What the running node writes to git（运行中的节点会写入 git）.** The server keeps running during a
deploy, and it changes the checkout by itself:

- **Tracked apps（已跟踪应用）.** The owner's apps (`workspace/apps/*/index.html`, `meta.json`) are
  tracked, and the agent can edit them live. `deploy.sh` lists the modified files and stops. Save
  the change (`git diff > ~/app-edits.patch`), commit it from your development machine (this
  node's deploy key is read-only), then `git restore` the files here and deploy — or `git restore`
  them to discard the edit.
- **Shelf commits（共享应用架提交）.** Promote, rollback and unshare in the web UI **commit** to this
  node's `main` (`shared-apps/<slug>`; web.mjs `commitShelf`), and the deploy key cannot push them.
  After one, `deploy.sh` refuses as *diverged* and lists the commits. Carry them over:
  `git format-patch origin/main..HEAD -o ~/shelf-patches`, then `git am` and push them from your
  development machine; back here, `git fetch && git reset --keep origin/main`. A shelf commit made
  *during* a deploy stops its rollback (exit 3, the commit is named) instead of dropping it.
- **New apps（新应用）** the agent creates are untracked: no deploy touches them, and they exist only
  on this node until you copy them to your development machine and commit them there.

## Credentials hygiene · 凭据卫生

- **Sign in to Claude and Codex inside the VM only（只在虚拟机内登录）.** Never copy `~/.claude`,
  `~/.codex` or any token in from another machine.
- **GitHub: a read-only deploy key（只读部署密钥）.** The agent can then `git pull` updates but
  cannot push, so a compromised agent cannot rewrite the code every other node pulls:

  ```bash
  ssh-keygen -t ed25519 -f ~/.ssh/superelf_deploy -N "" -C "superelf-vm read-only"
  cat ~/.ssh/superelf_deploy.pub
  ```

  GitHub → the repo → **Settings → Deploy keys → Add deploy key**, paste it, leave **"Allow write
  access" unticked**. Then:

  ```bash
  GIT_SSH_COMMAND="ssh -i ~/.ssh/superelf_deploy -o IdentitiesOnly=yes" \
    git clone git@github.com:csheargm/superelf.git
  git -C superelf config core.sshCommand "ssh -i ~/.ssh/superelf_deploy -o IdentitiesOnly=yes"
  ```

- **Nothing else from other machines（不带入其他机器的密钥）**: no personal SSH keys, no `gh`
  login, no cloud credentials, no browser profile.

## Snapshots · 快照

Take one **before every update** (`./deploy.sh`, `apt upgrade`), from Windows:

```powershell
Checkpoint-VM -Name superelf -SnapshotName before-update                 # Hyper-V
VBoxManage snapshot superelf take before-update                          # VirtualBox
vmrun -T ws snapshot "C:\VMs\superelf\superelf.vmx" before-update        # VMware
```

Restoring a snapshot also rolls back **family data** written since — a snapshot is an undo for a
bad update, **not a backup（快照不是备份）**. Delete old ones (`Remove-VMSnapshot -VMName superelf
-Name before-update` on Hyper-V): each one keeps growing a differencing disk.

## Moving data in, retiring the old node · 迁移，并停用旧节点

Follow [Moving an install to another machine](../README.md#moving-an-install-to-another-machine迁移):

1. On the old node: `./migrate.sh ~/superelf-migration` (read-only; it copies `config.json` and the
   workspaces byte for byte).
2. Get the bundle into the VM with `scp -r`, over the temporary SSH rule
   ([Do the rest over SSH](#do-the-rest-over-ssh-temporarily--之后临时用-ssh-操作)); then **remove the rule**.
3. In the VM, put `config.json` and the `workspace*/` folders into `~/superelf`, **then** run
   `./install.sh`. Already installed? **`./stop.sh` FIRST（先停止）**, copy, then `./install.sh` —
   a running node writes its blank accounts back over the migrated `config.json` on its next save.
4. **Retire the old node（停用旧节点）** — there must be **ONE active node（只有一个活动节点）**:
   two nodes split the family's data between them.
   - macOS: `./stop.sh`, then `rm ~/Library/LaunchAgents/com.superelf.web.plist` (otherwise launchd
     loads it again at the next login), then `tailscale serve reset`.
   - Windows: `.\stop.ps1`, then
     `Unregister-ScheduledTask -TaskName superelf-web -Confirm:$false` (and `superelf-bot`, the
     removed Telegram bot's task, if an old install still has it).

## Local models stay on the Mac · 本地模型留在 Mac 上

The VM has no GPU (none of these hypervisors pass one through on a family PC), and **MLX is
Apple-only**, so on-device models stay on the Mac. superelf's Ollama lanes call `ollama_url`
(default `http://localhost:11434`). Pointing it at the Mac would need an ACL rule from
`tag:superelf` to the Mac, which breaks "the VM reaches nothing"; if you accept that, allow one port
(`11434`) to one device. Ollama's `:cloud` models run on Ollama's servers, so an Ollama install
inside the VM can serve them — see Ollama's own docs for installing on Linux and signing in; this
guide does not pin those steps.

## WSL instead of a VM · 用 WSL 代替虚拟机

WSL is easier to set up and can use the PC's GPU (Ollama runs fast there), but it is built for
**integration**, not isolation: by default Linux sees `C:\` at `/mnt/c` and can launch Windows
programs as your Windows user. Hardened as below it is a reasonable middle ground. The weak point:
the first two switches live in `/etc/wsl.conf` **inside** Linux, so they hold only while superelf's
user has no password-free `sudo`. Keep the password Ubuntu asked for on first run; never add
`NOPASSWD`.

1. `wsl --install -d Ubuntu` (PowerShell), create the Linux user, keep its password.
2. Inside Ubuntu, `sudo nano /etc/wsl.conf`:
   ```ini
   [boot]
   systemd=true             # superelf's install.sh needs systemd for its service

   [automount]
   enabled=false            # C:\ is no longer visible at /mnt/c

   [interop]
   enabled=false            # Linux can no longer launch Windows programs
   appendWindowsPath=false
   ```
3. On Windows, `%UserProfile%\.wslconfig`:
   ```ini
   [general]
   instanceIdleTimeout=-1   # default 15000 ms: Ubuntu shuts down when idle, and services do not count
   ```
4. `wsl --shutdown`, wait about 8 seconds, open Ubuntu again; check `ls /mnt/c` fails and
   `systemctl --user status` answers.
5. Install superelf inside Ubuntu as in "Install superelf in the VM" above (`./install.sh`).
6. Start at boot: a Windows Scheduled Task, trigger **At startup**, **Run whether user is logged on
   or not**, as your Windows user, action `wsl.exe -d Ubuntu --exec /bin/true`. Starting Ubuntu
   once is enough; linger then starts superelf. (Community-documented, not in Microsoft's reference:
   confirm after the first Windows Update restart.)
7. Remote access: with WSL's default `localhostForwarding`, Windows reaches it at `localhost:8787`,
   so Tailscale can run on Windows: `tailscale serve --bg --https=443 8787` (tailnet only). The
   tailnet tag and ACL then apply to the whole PC, not just superelf.

Not covered here: blocking WSL from the home network. In a VM that is ufw (above); in WSL the
equivalent belongs on the Windows side (Hyper-V firewall rules for WSL), which this guide has not
verified yet.

Reference: Microsoft, "Advanced settings configuration in WSL"
(https://learn.microsoft.com/en-us/windows/wsl/wsl-config).
