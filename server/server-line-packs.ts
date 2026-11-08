// Every other language's server lines, from the app's packs (server-lines.ts reads English). The server loads this when
// it starts (server/index.ts), and so does a test that checks a line in another language; before that, a line reads in
// English. Only tests that load this read a translation, so only they run with the locale tests (scripts/ci-scope.mjs).
import zh from "../src/locales/zh.json" with { type: "json" };
import { addServerLinePacks } from "./server-lines.ts";

addServerLinePacks({ zh });
