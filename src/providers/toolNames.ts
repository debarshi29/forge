/**
 * Small models often call tools by names they saw in training rather than the
 * ones they were given ("read_file", "run_command", "functions.bash"). Map
 * those to the real tool when the meaning is unambiguous.
 */
const ALIASES: Record<string, string[]> = {
  read: ["read_file", "readfile", "file_read", "view", "view_file", "cat", "open_file", "get_file", "read_files"],
  write: ["write_file", "writefile", "file_write", "create_file", "save_file", "new_file", "write_to_file"],
  edit: ["edit_file", "file_edit", "replace", "str_replace", "replace_in_file", "modify_file", "update_file", "apply_edit"],
  glob: ["find_files", "glob_files", "file_search", "find_file"],
  ls: ["list", "list_files", "list_dir", "list_directory", "listdir", "dir", "list_folder"],
  grep: ["search", "search_code", "grep_search", "search_files", "find_in_files", "ripgrep", "rg", "code_search"],
  bash: [
    "run",
    "shell",
    "sh",
    "exec",
    "execute",
    "terminal",
    "cmd",
    "command",
    "run_command",
    "execute_command",
    "run_shell",
    "run_shell_command",
    "shell_command",
    "bash_command",
    "run_terminal_cmd",
    "powershell",
  ],
  todo_write: ["todo", "todos", "todowrite", "write_todos", "update_todos", "todo_list", "update_todo_list"],
  repo_map: ["repomap", "project_map", "code_map", "repo_overview", "outline"],
};

const LOOKUP = new Map<string, string>();
for (const [tool, names] of Object.entries(ALIASES)) for (const n of names) LOOKUP.set(n, tool);

function normalize(name: string): string {
  return name
    .trim()
    .replace(/^(functions|tools|tool|default_api)[.:]/i, "")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[\s.-]+/g, "_");
}

/** The real tool a model meant, or undefined when it isn't one of `known`. */
export function canonicalToolName(name: string, known: Set<string>): string | undefined {
  if (known.has(name)) return name;
  const n = normalize(name);
  if (known.has(n)) return n;
  const alias = LOOKUP.get(n);
  return alias && known.has(alias) ? alias : undefined;
}
