import { splitCommand } from "./rules.js";

/**
 * Commands that can destroy work or the machine. These always need an
 * explicit "yes" from the user: allow rules, acceptEdits, "don't ask again"
 * and even bypass mode can't approve them, and non-interactive runs refuse them.
 */
const DANGEROUS: Array<{ re: RegExp; why: string }> = [
  // Recursive deletes of the filesystem root, home, parent dirs or everything.
  {
    re: /\brm\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\b.*?(?:\s|^)(?:\/|\/\*|~\/?|~\/\*|\$HOME\/?|\.\.?\/?|\*|\.\/\*|[A-Za-z]:[\\/]?)(?:\s|$)/,
    why: "recursively deletes a root, home, parent or wildcard directory",
  },
  { re: /\brm\s+.*--no-preserve-root\b/, why: "deletes the filesystem root" },
  { re: /\bsudo\b/, why: "runs with administrator privileges" },
  { re: /\bmkfs(\.\w+)?\b|\bformat(\.com)?\s+[A-Za-z]:/i, why: "formats a disk" },
  { re: /\bdd\b.*\bof=\/dev\//, why: "writes raw bytes to a device" },
  { re: />\s*\/dev\/(sd|nvme|hd|disk)\w*/, why: "overwrites a disk device" },
  { re: /:\s*\(\s*\)\s*\{.*:\s*\|\s*:.*\}/, why: "is a fork bomb" },
  { re: /\bchmod\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)?[0-7]*777\s+(\/|~)(\s|$)/, why: "makes the whole system world-writable" },
  { re: /\bchown\s+-[a-zA-Z]*R[a-zA-Z]*\s+\S+\s+(\/|~)(\s|$)/, why: "changes ownership of the whole system" },
  { re: /\b(shutdown|reboot|halt|poweroff)\b|\bStop-Computer\b|\bRestart-Computer\b/i, why: "shuts down or restarts the machine" },
  // Git history and uncommitted work.
  { re: /\bgit\s+push\b.*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+\S+)/, why: "force-pushes, which can overwrite others' commits" },
  { re: /\bgit\s+push\b.*\s--(delete|mirror)\b|\bgit\s+push\s+\S+\s+:\S/, why: "deletes or mirrors remote branches" },
  { re: /\bgit\s+reset\s+.*--hard\b|\bgit\s+reset\s+--hard\b/, why: "discards uncommitted changes" },
  { re: /\bgit\s+clean\s+(-[a-zA-Z]*f|--force)/, why: "deletes untracked files" },
  { re: /\bgit\s+checkout\s+(--\s+)?\.(\s|$)|\bgit\s+restore\s+(?!--staged\b)\S*\s*\.(\s|$)/, why: "discards uncommitted changes" },
  { re: /\bgit\s+branch\s+.*-D\b/, why: "force-deletes a branch" },
  { re: /\bgit\s+stash\s+(drop|clear)\b/, why: "deletes stashed work" },
  { re: /\bgit\s+filter-(branch|repo)\b/, why: "rewrites history" },
  // Remote code straight into a shell.
  { re: /\b(curl|wget|iwr|Invoke-WebRequest|irm|Invoke-RestMethod)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/i, why: "pipes a download straight into a shell" },
  { re: /\b(iwr|Invoke-WebRequest|irm|Invoke-RestMethod)\b.*\|\s*(iex|Invoke-Expression)\b/i, why: "pipes a download straight into PowerShell" },
  // Windows equivalents.
  { re: /\bRemove-Item\b(?=.*-Recurse)(?=.*\s(?:[A-Za-z]:[\\/]?|~|\$HOME|\$env:USERPROFILE|\\|\/|\*|\.\.)(?:\s|$))/i, why: "recursively deletes a drive, home or wildcard directory" },
  { re: /\b(rd|rmdir)\s+\/s\b.*\s[A-Za-z]:[\\/]?(\s|$)|\bdel\s+.*\/s\b.*\s[A-Za-z]:[\\/]/i, why: "recursively deletes a drive" },
  { re: /\bFormat-Volume\b|\bClear-Disk\b|\bdiskpart\b/i, why: "erases a disk" },
  { re: /\breg\s+delete\s+HK(LM|EY_LOCAL_MACHINE)/i, why: "deletes system registry keys" },
  // Packages and databases.
  { re: /\bnpm\s+publish\b|\bpnpm\s+publish\b|\byarn\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/, why: "publishes a package" },
  { re: /\bDROP\s+(DATABASE|SCHEMA|TABLE)\b|\bTRUNCATE\s+TABLE\b/i, why: "drops database objects" },
];

/** Why a command is dangerous, or undefined if it isn't on the list. */
export function dangerReason(command: string): string | undefined {
  const pieces = [command, ...splitCommand(command)];
  for (const piece of pieces) {
    for (const d of DANGEROUS) if (d.re.test(piece)) return d.why;
  }
  return undefined;
}
