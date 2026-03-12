import { test, expect } from "bun:test";
import React from "react";
import { renderHTML } from "../test-helpers";
import { Input } from "./Input";

test("Input renders as input element", () => {
  const html = renderHTML(React.createElement(Input));
  expect(html).toContain("<input");
});

test("Input renders without label wrapper by default", () => {
  const html = renderHTML(React.createElement(Input));
  expect(html).toMatch(/^<input/);
});

test("Input renders with label when provided", () => {
  const html = renderHTML(React.createElement(Input, { label: "Email", id: "email" }));
  expect(html).toContain("Email");
  expect(html).toContain("<label");
  expect(html).toContain('for="email"');
});

test("Input wraps in div when label is provided", () => {
  const html = renderHTML(React.createElement(Input, { label: "Name" }));
  expect(html).toMatch(/^<div/);
});

test("Input passes className through", () => {
  const html = renderHTML(React.createElement(Input, { className: "extra-class" }));
  expect(html).toContain("extra-class");
});

test("Input passes placeholder through", () => {
  const html = renderHTML(React.createElement(Input, { placeholder: "Type here..." }));
  expect(html).toContain('placeholder="Type here..."');
});

test("Input passes type through", () => {
  const html = renderHTML(React.createElement(Input, { type: "password" }));
  expect(html).toContain('type="password"');
});

test("Input has base styling classes", () => {
  const html = renderHTML(React.createElement(Input));
  expect(html).toContain("rounded-lg");
  expect(html).toContain("border");
});

test("Input label has uppercase styling", () => {
  const html = renderHTML(React.createElement(Input, { label: "Test" }));
  expect(html).toContain("uppercase");
});
