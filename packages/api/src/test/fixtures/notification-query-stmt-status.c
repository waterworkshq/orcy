/* Optional native work-test instrumentation; load only into an isolated fixture. */
#include <sqlite3ext.h>
#include <string.h>
SQLITE_EXTENSION_INIT1

static void read_status(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  static const int ops[5] = {
    SQLITE_STMTSTATUS_VM_STEP, SQLITE_STMTSTATUS_FULLSCAN_STEP,
    SQLITE_STMTSTATUS_SORT, SQLITE_STMTSTATUS_AUTOINDEX, SQLITE_STMTSTATUS_RUN
  };
  sqlite3_int64 totals[5] = {0, 0, 0, 0, 0};
  sqlite3 *db = sqlite3_context_db_handle(ctx);
  sqlite3_stmt *stmt = 0;
  const char *wanted;
  char *json;
  int reset, matches = 0, i;
  if (argc != 2 || sqlite3_value_type(argv[0]) != SQLITE_TEXT ||
      sqlite3_value_type(argv[1]) != SQLITE_INTEGER) {
    sqlite3_result_error(ctx, "expected exact SQL text and integer reset flag", -1);
    return;
  }
  wanted = (const char *)sqlite3_value_text(argv[0]);
  if (!wanted) { sqlite3_result_error_nomem(ctx); return; }
  reset = sqlite3_value_int(argv[1]) != 0;
  while ((stmt = sqlite3_next_stmt(db, stmt)) != 0) {
    const char *sql = sqlite3_sql(stmt);
    if (!sql || strcmp(sql, wanted) != 0) continue;
    ++matches;
    for (i = 0; i < 5; ++i) {
      int value = sqlite3_stmt_status(stmt, ops[i], reset);
      if (value < 0) {
        sqlite3_result_error(ctx, "negative statement counter; evidence invalid", -1);
        return;
      }
      totals[i] += value;
    }
  }
  json = sqlite3_mprintf(
    "{\"matches\":%d,\"vmSteps\":%lld,\"fullscanSteps\":%lld,"
    "\"sorts\":%lld,\"autoindexRows\":%lld,\"runs\":%lld}",
    matches, totals[0], totals[1], totals[2], totals[3], totals[4]);
  if (!json) { sqlite3_result_error_nomem(ctx); return; }
  sqlite3_result_text(ctx, json, -1, sqlite3_free);
}

#ifdef _WIN32
__declspec(dllexport)
#endif
int sqlite3_orcystmtstatus_init(
  sqlite3 *db, char **error, const sqlite3_api_routines *api
) {
  (void)error;
  SQLITE_EXTENSION_INIT2(api);
  if (!api || !api->next_stmt || !api->sql || !api->stmt_status)
    return SQLITE_ERROR;
  return sqlite3_create_function_v2(db, "probe_stmt_status", 2,
    SQLITE_UTF8 | SQLITE_DIRECTONLY, 0, read_status, 0, 0, 0);
}
