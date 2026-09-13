import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import MovieStudio from "../src/app/page";

test("studio defaults to a truthful 15-second movie with only two still bookends", () => {
  const html = renderToStaticMarkup(createElement(MovieStudio));
  assert.match(html, /format-stamp"><span>15<\/span>/);
  assert.match(html, /2 BOOKENDS \+ VIDEO/);
  assert.match(html, /Opening zoom \(3s\), real animation \(8s\), closing zoom \(4s\)/);
  assert.match(html, /No still-only shots in the middle/);
  assert.match(html, /story references, not extra still shots in the movie/);
});
