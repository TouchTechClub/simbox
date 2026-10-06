import { expect, test } from "bun:test";
import { skillInstallArgs, selectSkillScope } from "../apps/cli/src/skills.js";

test("skill installer asks current project vs global without guessing or auth", async () => {
  let prompt = "";
  const project = await selectSkillScope({}, true, async (question) => {
    prompt = question;
    return "1";
  });
  expect(prompt).toContain("Current project");
  expect(prompt).toContain("Global");
  expect(skillInstallArgs(project)).toEqual([
    "skills",
    "add",
    "TouchTechClub/simbox",
    "--skill",
    "simbox",
  ]);
  const global = await selectSkillScope({}, true, async () => "2");
  expect(skillInstallArgs(global)).toContain("--global");
  let calls = 0;
  await selectSkillScope({}, true, async () => (++calls === 1 ? "" : "project"));
  expect(calls).toBe(2);
  await expect(selectSkillScope({}, true, async () => "q")).rejects.toThrow("canceled");
});

test("skill installation automation requires explicit scope and agents", async () => {
  await expect(selectSkillScope({}, false, async () => "1")).rejects.toThrow(
    "--project or --global",
  );
  await expect(selectSkillScope({ yes: true }, true, async () => "1")).rejects.toThrow(
    "--project or --global",
  );
  expect(() => skillInstallArgs({ project: true, global: true })).toThrow("not both");
  expect(() => skillInstallArgs({ project: true, yes: true })).toThrow("--agent");
  expect(skillInstallArgs({ global: true, agent: ["codex", "claude-code"], yes: true })).toEqual([
    "skills",
    "add",
    "TouchTechClub/simbox",
    "--skill",
    "simbox",
    "--global",
    "--agent",
    "codex",
    "claude-code",
    "--yes",
  ]);
  expect(() => skillInstallArgs({ project: true, agent: ["--all"] })).toThrow("Invalid agent");
  expect(() => skillInstallArgs({ project: true, agent: ["codex;touch /tmp/pwned"] })).toThrow(
    "Invalid agent",
  );
});

test("published skill remains concise, discoverable and includes safety/cleanup guidance", async () => {
  const skill = await Bun.file(new URL("../skills/simbox/SKILL.md", import.meta.url)).text();
  expect(skill).toMatch(/^---\nname: simbox\ndescription: .+\n---/);
  expect(skill.split(/\s+/).length).toBeLessThan(750);
  expect(skill).toContain("Never blindly replay");
  expect(skill).toContain("simbox stop");
  expect(skill).toContain("simbox exec");
});
