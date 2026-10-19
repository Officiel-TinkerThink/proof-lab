// Turns a step's target fields into a Playwright locator. Shadow DOM (open) is pierced by Playwright itself.
import { TARGET_KEYS } from "./schema.js";
import { defined, pick } from "./util.js";

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
