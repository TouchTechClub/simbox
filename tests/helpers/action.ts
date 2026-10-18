/** The `run: |` script of a named step in action-src/action.yml.template. */
export async function actionStepScript(name: string): Promise<string> {
  const template = await Bun.file(
    new URL("../../action-src/action.yml.template", import.meta.url),
  ).text();
  const lines = template.split("\n");
  const start = lines.indexOf(`    - name: ${name}`);
  if (start < 0) throw new Error(`no action step named ${name}`);
  const run = lines.indexOf("      run: |", start);
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() && !line.startsWith("        ")) break;
    body.push(line.slice(8));
  }
  return body.join("\n");
}
