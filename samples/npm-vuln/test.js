const _ = require("lodash");

// Pure behaviour that lodash 4.x provides on every version.
const chunks = _.chunk([1, 2, 3, 4, 5], 2);
if (JSON.stringify(chunks) !== JSON.stringify([[1, 2], [3, 4], [5]])) {
  console.error("FAIL: _.chunk returned " + JSON.stringify(chunks));
  process.exit(1);
}
console.log("ok: lodash _.chunk behaves as expected");
