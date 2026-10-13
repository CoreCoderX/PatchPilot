const _ = {
  chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) {
      out.push(arr.slice(i, i + size));
    }
    return out;
  },
};
const { greet } = require("./src/greet.js");

const chunks = _.chunk([1, 2, 3, 4, 5], 2);
if (JSON.stringify(chunks) !== JSON.stringify([[1, 2], [3, 4], [5]])) {
  console.error("FAIL: _.chunk returned " + JSON.stringify(chunks));
  process.exit(1);
}
const message = greet("Ada");
if (message !== "Hello, Ada") {
  console.error(
    'FAIL src/greet.js: expected "Hello, Ada", got "' + message + '"',
  );
  process.exit(1);
}
console.log("ok: greeting and lodash checks pass");
