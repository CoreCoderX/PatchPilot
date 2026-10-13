import * as path from "node:path";
import Mocha from "mocha";

/** Entry point loaded inside the Extension Development Host. */
export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: "bdd", color: false, timeout: 20000 });
  mocha.addFile(path.resolve(__dirname, "extension.test.js"));

  await new Promise<void>((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${String(failures)} extension smoke test(s) failed.`));
      } else {
        resolve();
      }
    });
  });
}
