// Turns a step's target fields into a Playwright locator. Shadow DOM (open) is pierced by Playwright itself.
import { TARGET_KEYS } from "./schema.js";
import { bounded, defined, pick } from "./util.js";

const ROLE_STATES = ["checked", "disabled", "expanded", "pressed", "selected", "level", "includeHidden"];

export const hasTarget = spec => TARGET_KEYS.some(key => spec[key] !== undefined);

// Short text for check names and failure messages, for example "role=button name=Join waitlist".
export function describeTarget(spec) {
  const key = TARGET_KEYS.find(candidate => spec[candidate] !== undefined);
  if (!key) return "";
  const name = key === "role" && spec.name !== undefined ? ` name=${spec.name}` : "";
  return `${key}=${spec[key]}${name}`;
}

function scopeOf(page, frame) {
  let scope = page;
  for (const selector of [].concat(frame ?? [])) scope = scope.frameLocator(selector);
  return scope;
}

// Names and text match whole strings by default: a spec says exactly what it expects. exact: false loosens that.
export function locate(page, spec) {
  const scope = scopeOf(page, spec.frame);
  const exact = spec.exact ?? true;
  let locator;
  if (spec.role !== undefined) {
    locator = scope.getByRole(spec.role, defined({
      name: spec.name,
      exact: spec.name === undefined ? undefined : exact,
      ...pick(spec, ROLE_STATES),
    }));
  } else if (spec.label !== undefined) {
    locator = scope.getByLabel(spec.label, { exact });
  } else if (spec.text !== undefined) {
    locator = scope.getByText(spec.text, { exact });
  } else if (spec.placeholder !== undefined) {
    locator = scope.getByPlaceholder(spec.placeholder, { exact });
  } else if (spec.altText !== undefined) {
    locator = scope.getByAltText(spec.altText, { exact });
  } else if (spec.title !== undefined) {
    locator = scope.getByTitle(spec.title, { exact });
  } else if (spec.testId !== undefined) {
    locator = scope.getByTestId(spec.testId);
  } else {
    locator = scope.locator(spec.selector);
  }
  if (spec.hasText !== undefined) locator = locator.filter({ hasText: spec.hasText });
  return spec.nth === undefined ? locator : locator.nth(spec.nth);
}

// For a target that matched several elements: the first few as "<tag id=x data-testid=y name=z>", read from the page
// itself, never parsed from an error message. Only the tag and the id, data-testid and name attributes that are plain
// identifiers are kept; no text and no value of the page leaves it. Empty when the page cannot answer.
const MAX_LISTED_ELEMENTS = 4;
export async function describeMatches(page, spec) {
  try {
    const found = await bounded(locate(page, { ...spec, nth: undefined }).evaluateAll((elements, limit) => elements.slice(0, limit).map(element => {
      const plain = value => (/^[A-Za-z0-9_-]{1,40}$/.test(value ?? "") ? value : null);
      return { tag: element.tagName.toLowerCase(), id: plain(element.getAttribute("id")), testId: plain(element.getAttribute("data-testid")), name: plain(element.getAttribute("name")) };
    }), MAX_LISTED_ELEMENTS), 2000, "listing the matches");
    return found.map(({ tag, id, testId, name }) => `<${[tag, id && `id=${id}`, testId && `data-testid=${testId}`, name && `name=${name}`].filter(Boolean).join(" ")}>`);
  } catch {
    return [];
  }
}
