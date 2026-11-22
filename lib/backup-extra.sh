# Extra folders in the nightly backup · 额外备份文件夹. Sourced by backup.sh and restore.sh.
# config.json "backup_extra": [{ "dir": "/absolute/folder", "exclude": ["vm", "*/.cache"],
#   "pause": ["/absolute/program", "arg"], "resume": ["/absolute/program", "arg"] }]
# (default: none; read on every run). "exclude" entries are paths inside that folder; * matches any
# characters, / included. "pause" and "resume" (optional, both or neither) run right before and
# right after that folder is packed, so a program that writes there (an open database, a browser
# profile) is still while it is copied; resume runs whatever happens, so it must do nothing when
# nothing is paused. Without them the folder is copied as it is at that moment, like any live copy.
# Each folder is packed by its OWN tar into <BACKUP_EXTRA>/<k>.tar (the k-th line of
# <BACKUP_EXTRA>/folders; members at <BACKUP_EXTRA>/root/<its absolute path>), which rides in the
# SAME encrypted archive as the superelf folder. One tar's exit status covers everything it packs,
# so a file deleted mid-copy in an extra folder would otherwise fail the superelf backup too.
BACKUP_EXTRA=backup-extra

# Reads and checks backup_extra. Prints NUL-separated pairs, per folder: "p" <arg> for each word of
# its pause, "r" <arg> for each word of its resume, "x" <folder>/<exclude> for each exclude, and last
# "d" <folder>. A folder that does not exist, or whose resume program cannot run (it would stay
# paused), is skipped with a warning, so the superelf folder is still backed up; a malformed entry
# stops the backup before anything is written.
EXTRA_READ='
const fs = require("fs"), path = require("path");
const [cfgFile, nodeDir, dest] = process.argv.slice(1);
const die = (m) => { console.error(`backup: backup_extra: ${m}`); process.exit(1); };
const list = require(cfgFile).backup_extra ?? [];
if (!Array.isArray(list)) die(`must be a list like [{ "dir": "/absolute/folder", "exclude": ["vm"] }]`);
const within = (a, b) => a === b || a.startsWith(b.endsWith("/") ? b : b + "/");
const taken = [["the superelf folder", fs.realpathSync(nodeDir)]];
if (dest) taken.push(["the backup folder", fs.realpathSync(dest)]);
const norm = (x) => x.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
const badEx = (x) => typeof x !== "string" || x.startsWith("/") || x.includes("\n")
  || !norm(x) || norm(x) === "." || norm(x).split("/").includes("..");
const okCmd = (c) => Array.isArray(c) && c.length > 0 && typeof c[0] === "string" && path.isAbsolute(c[0])
  && c.every((a) => typeof a === "string" && !a.includes("\0"));
// An error here (no such file, no permission) is the answer "it cannot run"; the caller says so.
const canRun = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };
const out = [];
for (const e of list) {
  const raw = e && typeof e === "object" ? e.dir : undefined;
  const dir = typeof raw === "string" ? raw.replace(/(.)\/+$/, "$1") : "";
  if (!path.isAbsolute(dir) || path.normalize(dir) !== dir || dir === "/" || /[\n*?[\\]/.test(dir)) {
    die(`"dir" must be an absolute folder path, got ${JSON.stringify(raw)}`);
  }
  const ex = e.exclude ?? [];
  if (!Array.isArray(ex) || ex.some(badEx)) die(`"exclude" of ${dir} must list paths inside it`);
  const pause = e.pause ?? null, resume = e.resume ?? null;
  if (!pause !== !resume) die(`"pause" and "resume" of ${dir} go together: name both or neither`);
  for (const [k, c] of [["pause", pause], ["resume", resume]]) {
    if (c && !okCmd(c)) die(`"${k}" of ${dir} must be a command list like ["/absolute/program", "arg"]`);
  }
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!st) { console.error(`backup: extra folder missing, skipped: ${dir}`); continue; }
  if (st.isSymbolicLink()) die(`${dir} is a link: list the folder it points to`);
  if (!st.isDirectory()) die(`${dir} is not a folder`);
  const real = fs.realpathSync(dir);
  const clash = taken.find(([, t]) => within(real, t) || within(t, real));
  if (clash) die(`${dir} overlaps ${clash[0]}`);
  if (resume && !canRun(resume[0])) { console.error(`backup: extra folder skipped, its resume program cannot run: ${dir} (${resume[0]})`); continue; }
  taken.push([dir, real]);
  const words = (k, c) => (c ?? []).flatMap((a) => [k, a]);
  out.push(...words("p", pause), ...words("r", resume), ...ex.flatMap((x) => ["x", `${dir}/${norm(x)}`]), "d", dir);
}
process.stdout.write(out.map((s) => s + "\0").join(""));
'

EXTRA_RESUME=() EXTRA_STUCK=
# A pause or resume that hangs (colima can hang after the Mac wakes; the backup runs at 03:30 or on
# wake) is cut off after this many seconds, with its whole process group, so one stuck program never
# holds up the night. The env override is for the tests.
EXTRA_STEP_SECS=${BACKUP_EXTRA_STEP_SECS:-120}
extra_timed() {
  perl -e 'my $t = shift; my $pid = fork() // exit 126;
    if ($pid == 0) { setpgrp(0, 0); exec @ARGV; exit 127 }
    $SIG{ALRM} = sub { kill "KILL", -$pid; kill "KILL", $pid; exit 142 }; alarm $t;
    waitpid($pid, 0); exit($? & 127 ? 128 + ($? & 127) : $? >> 8)' "$EXTRA_STEP_SECS" "$@"
}

# backup.sh side. $1 = an empty private folder, $2 = the local backup folder ("" for a remote one).
# Packs each folder into $1/<BACKUP_EXTRA>/<k>.tar and sets EXTRA_OPS (-C $1 and the names the
# backup packs) and EXTRA_NOTE. $1/<BACKUP_EXTRA>/root is a link to /, so each folder is packed by
# its own path through it; tar never follows the link itself, it is only a step in the path.
extra_stage() {
  local kind val n=0 pause=() resume=() excl=()
  EXTRA_OPS=() EXTRA_NOTE=
  node -e "$EXTRA_READ" "$PWD/config.json" "$PWD" "$2" > "$1/args"
  mkdir "$1/$BACKUP_EXTRA"; ln -s / "$1/$BACKUP_EXTRA/root"
  while IFS= read -r -d '' kind && IFS= read -r -d '' val; do
    case "$kind" in
      p) pause+=("$val") ;;
      r) resume+=("$val") ;;
      x) excl+=(--exclude "$BACKUP_EXTRA/root$val") ;;
      d) if extra_pack "$1" "$val" "$BACKUP_EXTRA/$((n + 1)).tar"; then
           n=$((n + 1)); EXTRA_OPS+=("$BACKUP_EXTRA/$n.tar"); EXTRA_NOTE="${EXTRA_NOTE:+$EXTRA_NOTE, }$val"
           printf '%s\n' "$val" >> "$1/$BACKUP_EXTRA/folders"
         fi
         pause=() resume=() excl=() ;;
    esac
  done < "$1/args"
  if [[ -n "$EXTRA_NOTE" ]]; then EXTRA_OPS=(-C "$1" "$BACKUP_EXTRA/folders" "${EXTRA_OPS[@]}"); fi
}

# One folder, for extra_stage (it reads that function's pause, resume and excl): $1 = the private
# folder, $2 = the folder, $3 = its archive, relative to $1. A read error there fails this tar
# only, and its copy is not kept: bsdtar (3.5.3) writes nothing after the first file it cannot
# open, and breaks off the archive when a file is deleted while it reads it, so a failed copy can
# lack any part of the folder. Returns 1, after a warning, when the folder is left out tonight.
extra_pack() {
  local st=0
  if (( ${#pause[@]} )); then
    EXTRA_RESUME=("${resume[@]}")   # set first: a failed pause, or a signal from here on, still resumes
    extra_timed "${pause[@]}" < /dev/null || st=$?
    if (( st )); then
      extra_resume; echo "backup: WARNING: pause failed (exit $st), extra folder skipped: $2" >&2; return 1
    fi
  fi
  tar -cf "$1/$3" --exclude .DS_Store ${excl[@]+"${excl[@]}"} -C "$1" "$BACKUP_EXTRA/root$2" || st=$?
  extra_resume
  (( st )) || return 0
  rm -f "$1/$3"; echo "backup: WARNING: $2 could not be read whole (tar exit $st, above), skipped tonight" >&2; return 1
}

# Runs the paused folder's resume, once: from extra_pack, and from backup.sh's exit trap, so a
# failure or a signal while a folder is paused still resumes it. A failed resume is loud, and sets
# EXTRA_STUCK (backup.sh then ends with exit 1): the program may still be paused.
extra_resume() {
  local cmd=() st=0
  (( ${#EXTRA_RESUME[@]} )) || return 0
  cmd=("${EXTRA_RESUME[@]}"); EXTRA_RESUME=()
  extra_timed "${cmd[@]}" < /dev/null || st=$?
  if (( st )); then
    EXTRA_STUCK=1; echo "backup: WARNING: resume failed (exit $st), it may still be paused; run: ${cmd[*]}" >&2
  fi
  return 0
}

# Removes exactly what extra_stage made. Never rm -r here: root is a link to /.
extra_unstage() {
  rm -f "$1/args" "$1/$BACKUP_EXTRA/folders" "$1/$BACKUP_EXTRA/root" "$1/$BACKUP_EXTRA/"*.tar
  if [[ -d "$1/$BACKUP_EXTRA" ]]; then rmdir "$1/$BACKUP_EXTRA"; fi
  rmdir "$1"
}

# restore.sh side. $1 = the folder just restored. Each listed folder goes back to its own path when
# that is new or an empty folder. A folder that has files is never touched: the copy goes beside it.
extra_place() {
  local list="$1/$BACKUP_EXTRA/folders" dir src dest k=0
  [[ -f "$list" ]] || return 0   # a backup made without backup_extra
  while IFS= read -r dir; do
    k=$((k + 1)); src="$1/$BACKUP_EXTRA/root$dir"
    if ! tar -xf "$1/$BACKUP_EXTRA/$k.tar" -C "$1" < /dev/null; then echo "restore: $dir could not be unpacked" >&2; continue; fi
    rm -f "$1/$BACKUP_EXTRA/$k.tar"
    if [[ ! -d "$src" ]]; then echo "restore: $dir is listed but not in this backup" >&2; continue; fi
    dest=$(extra_dest "$dir")
    # Missing parents (a new machine) get ordinary permissions: they are path steps, not data.
    if ! (umask 022 && mkdir -p "$(dirname "$dest")"); then echo "restore: $dir left in $src" >&2; continue; fi
    if [[ "$dest" == "$dir" && -d "$dir" ]]; then rmdir "$dir"; fi   # an empty folder makes way
    mv "$src" "$dest"
    if [[ "$dest" == "$dir" ]]; then echo "Restored $dir."
    else echo "$dir already has files, so it was not touched; the backup copy is beside it: $dest"; fi
  done < "$list"
  rm -f "$list"
  find "$1/$BACKUP_EXTRA" -depth -type d -empty -delete   # the empty path steps left behind
  if [[ -e "$1/$BACKUP_EXTRA" ]]; then echo "restore: kept $1/$BACKUP_EXTRA: not everything in it was placed" >&2; fi
}

# Prints $1 when it is new or an empty folder; otherwise a name beside it that is not taken.
extra_dest() {
  local stamp dest n=1
  if [[ ! -L "$1" ]] && { [[ ! -e "$1" ]] || [[ -d "$1" && -z "$(ls -A "$1")" ]]; }; then echo "$1"; return; fi
  stamp=$(date +%Y%m%d-%H%M%S); dest="$1.restored-$stamp"
  while [[ -e "$dest" || -L "$dest" ]]; do n=$((n + 1)); dest="$1.restored-$stamp-$n"; done
  echo "$dest"
}
