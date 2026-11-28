import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SessionStateProvider } from "../../lib/sessionState.js";
import { HabitatListPage } from "./HabitatListPage.js";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function mount() {
  return render(
    <MemoryRouter>
      <SessionStateProvider>
        <HabitatListPage />
      </SessionStateProvider>
    </MemoryRouter>,
  );
}

/** Empty habitat list, synthetic agent registration with setup credentials. */
function stubApi() {
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string) => {
      if (path === "/api/agents") {
        return Promise.resolve(json({ agent: { id: "agent", name: "Test agent" }, apiKey: "synthetic-key" }));
      }
      if (path === "/api/habitats") return Promise.resolve(json({ habitats: [] }));
      return Promise.resolve(json({ teams: [] }));
    }),
  );
}

async function openWelcome() {
  mount();
  await screen.findByText("Welcome to Orcy");
}

async function openRegistration() {
  const register = screen.getByRole("button", { name: "Register" });
  register.focus();
  fireEvent.click(register);
  return screen.findByLabelText("Agent Name");
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps the welcome open and completion unset when Escape dismisses the registration dialog", async () => {
  stubApi();
  await openWelcome();
  const name = await openRegistration();
  name.focus();
  fireEvent.keyDown(name, { key: "Escape" });
  expect(screen.getByText("Welcome to Orcy")).toBeTruthy();
  expect(screen.queryByLabelText("Agent Name")).toBeNull();
  expect(localStorage.getItem("orcy_onboarding_completed")).toBeNull();
});

it("keeps the welcome open and completion unset when Escape dismisses a displayed registration result", async () => {
  stubApi();
  await openWelcome();
  fireEvent.change(await openRegistration(), { target: { value: "Test agent" } });
  fireEvent.click(screen.getByRole("button", { name: "Register Agent" }));
  await screen.findByText(/synthetic-key/);
  const copy = screen.getByRole("button", { name: "Copy Credentials" });
  copy.focus();
  fireEvent.keyDown(copy, { key: "Escape" });
  // Child contract: the dialog dismisses its one-time result; the parent stays.
  expect(screen.queryByText(/synthetic-key/)).toBeNull();
  expect(screen.getByText("Welcome to Orcy")).toBeTruthy();
  expect(localStorage.getItem("orcy_onboarding_completed")).toBeNull();
});

it("completes onboarding on a later Escape once the registration dialog has closed", async () => {
  stubApi();
  await openWelcome();
  const name = await openRegistration();
  name.focus();
  fireEvent.keyDown(name, { key: "Escape" });
  expect(screen.getByText("Welcome to Orcy")).toBeTruthy();
  expect(localStorage.getItem("orcy_onboarding_completed")).toBeNull();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByText("Welcome to Orcy")).toBeNull();
  expect(localStorage.getItem("orcy_onboarding_completed")).toBe("true");
});

it("keeps the welcome open and completion unset when the registration dialog is cancelled", async () => {
  stubApi();
  await openWelcome();
  await openRegistration();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByLabelText("Agent Name")).toBeNull();
  expect(screen.getByText("Welcome to Orcy")).toBeTruthy();
  expect(localStorage.getItem("orcy_onboarding_completed")).toBeNull();
});

it("returns focus to the register control after the registration dialog closes", async () => {
  stubApi();
  await openWelcome();
  await openRegistration();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Register" }));
});

it("completes onboarding when Escape is pressed with only the welcome open", async () => {
  stubApi();
  await openWelcome();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByText("Welcome to Orcy")).toBeNull();
  expect(localStorage.getItem("orcy_onboarding_completed")).toBe("true");
});

it("completes onboarding explicitly", async () => {
  stubApi();
  await openWelcome();
  fireEvent.click(screen.getByRole("button", { name: "Get Started" }));
  expect(screen.queryByText("Welcome to Orcy")).toBeNull();
  expect(localStorage.getItem("orcy_onboarding_completed")).toBe("true");
});
