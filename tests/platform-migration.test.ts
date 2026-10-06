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

test("runner migration preserves historical runs/repos and isolates account defaults", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(
      "PRAGMA foreign_keys=ON; CREATE TABLE user (id text PRIMARY KEY); CREATE TABLE repos (user_id text PRIMARY KEY); CREATE TABLE runs (id text PRIMARY KEY); INSERT INTO user VALUES ('owner'); INSERT INTO repos VALUES ('owner'); INSERT INTO runs VALUES ('legacy');",
    );
    db.exec(
      await Bun.file(
        new URL(
          "../packages/db/migrations/20261005190841_greedy_typhoid_mary/migration.sql",
          import.meta.url,
        ),
      ).text(),
    );
    expect(db.query("SELECT * FROM runs").get()).toEqual({ id: "legacy", runner: null });
    expect(db.query("SELECT * FROM repos").get()).toEqual({
      user_id: "owner",
      ios_runner: null,
      android_runner: null,
    });
    expect(db.query("SELECT * FROM runner_settings").all()).toEqual([]);
    db.query("INSERT INTO runner_settings (user_id, android_runner) VALUES (?, ?)").run(
      "owner",
      JSON.stringify({ labels: ["ubuntu-latest"] }),
    );
    db.exec("DELETE FROM repos WHERE user_id='owner'");
    expect(db.query("SELECT user_id FROM runner_settings").get()).toEqual({ user_id: "owner" });
    db.exec("DELETE FROM user WHERE id='owner'");
    expect(db.query("SELECT * FROM runner_settings").all()).toEqual([]);
  } finally {
    db.close();
  }
});
