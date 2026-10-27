const MIGRATION_PATTERN = /^\d+_[A-Za-z0-9._-]+\.sql$/;

export function migrationLedgerSQL(names) {
  const ordered = [...new Set(names)].sort();
  if (ordered.some((name) => !MIGRATION_PATTERN.test(name))) {
    throw new Error("migration names must be SQL migration filenames");
  }
  const statements = [
    "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);",
  ];
  if (ordered.length) {
    statements.push("INSERT OR IGNORE INTO d1_migrations (name) VALUES\n" +
      ordered.map((name) => "(" + sqlString(name) + ")").join(",\n") + ";");
  }
  return statements.join("\n") + "\n";
}

function sqlString(value) {
  return "'" + value.replaceAll("'", "''") + "'";
}
