import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";

test("platform migration preserves old runs as iOS and supports new Android runs", async () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE runs (id text PRIMARY KEY); INSERT INTO runs VALUES ('existing');");
    db.exec(
      await Bun.file(
        new URL(
          "../packages/db/migrations/20261004180005_watery_thor_girl/migration.sql",
          import.meta.url,
        ),
      ).text(),
    );
    expect(db.query("SELECT platform FROM runs WHERE id='existing'").get()).toEqual({
      platform: "ios",
    });
    db.exec("INSERT INTO runs (id, platform) VALUES ('new-android', 'android');");
    expect(db.query("SELECT platform FROM runs WHERE id='new-android'").get()).toEqual({
      platform: "android",
    });
  } finally {
    db.close();
  }
});
