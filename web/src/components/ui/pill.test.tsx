// React rendering test for Pill / Dot.
//
// Uses ReactDOMServer.renderToStaticMarkup — no jsdom / @testing-library
// is required, which keeps the dev-dependency surface small. This covers
// the rendering contract (className, data-tone, children pass-through);
// interactive component tests should add @testing-library/react when needed.

import ReactDOMServer from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Dot, Pill } from "./pill";

describe("Pill", () => {
  it("renders children inside a span", () => {
    const html = ReactDOMServer.renderToStaticMarkup(<Pill>hello</Pill>);
    expect(html).toMatch(/<span [^>]*>hello<\/span>/);
  });

  it("defaults to tone=neutral", () => {
    const html = ReactDOMServer.renderToStaticMarkup(<Pill>x</Pill>);
    expect(html).toContain('data-tone="neutral"');
  });

  it("forwards the tone prop as data-tone", () => {
    for (const tone of ["ok", "warn", "err", "neutral"] as const) {
      const html = ReactDOMServer.renderToStaticMarkup(<Pill tone={tone}>x</Pill>);
      expect(html).toContain(`data-tone="${tone}"`);
    }
  });

  it("appends caller className to the default class", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <Pill className="extra-class">y</Pill>,
    );
    expect(html).toContain("extra-class");
  });

  it("accepts complex child nodes", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <Pill>
        <strong>bold</strong>
        <em>italic</em>
      </Pill>,
    );
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
  });
});

describe("Dot", () => {
  it("renders an empty span", () => {
    const html = ReactDOMServer.renderToStaticMarkup(<Dot />);
    expect(html).toMatch(/<span [^>]*\/>|<span [^>]*><\/span>/);
  });

  it("defaults to tone=neutral", () => {
    const html = ReactDOMServer.renderToStaticMarkup(<Dot />);
    expect(html).toContain('data-tone="neutral"');
  });

  it("supports the live tone (which Pill does not)", () => {
    const html = ReactDOMServer.renderToStaticMarkup(<Dot tone="live" />);
    expect(html).toContain('data-tone="live"');
  });
});
