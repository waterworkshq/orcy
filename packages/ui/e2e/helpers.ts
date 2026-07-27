import type { APIRequestContext, Page } from "@playwright/test";

export const ADMIN = { username: "admin", password: "admin123" };

export async function login(
  request: APIRequestContext,
): Promise<{ token: string; userId: string }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await request.post("/api/auth/login", { data: ADMIN });
    if (res.status() === 429) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    const body = await res.json();
    return { token: body.token, userId: body.user.id };
  }
  throw new Error("login failed after 5 retries");
}

export async function authenticatePage(page: Page, token: string): Promise<void> {
  await page.goto("/app/login");
  await page.evaluate((t) => localStorage.setItem("orcy_token", t), token);
}

export async function createHabitat(
  request: APIRequestContext,
  token: string,
  name: string,
): Promise<{
  habitat: { id: string; name: string };
  columns: Array<{ id: string; name: string; order: number }>;
}> {
  const res = await request.post("/api/habitats", {
    data: { name, defaultColumns: true },
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  return {
    habitat: body.habitat,
    columns: body.columns,
  };
}

export async function createMission(
  request: APIRequestContext,
  token: string,
  habitatId: string,
  title: string,
  columnId: string,
): Promise<{ mission: { id: string; title: string } }> {
  const res = await request.post(`/api/habitats/${habitatId}/missions`, {
    data: { title, columnId },
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  return { mission: body.mission };
}

export async function archiveMission(
  request: APIRequestContext,
  token: string,
  missionId: string,
): Promise<void> {
  await request.post(`/api/missions/${missionId}/archive`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function moveMission(
  request: APIRequestContext,
  token: string,
  missionId: string,
  columnId: string,
  expectedVersion: number,
): Promise<void> {
  await request.post(`/api/missions/${missionId}/move`, {
    data: { columnId, expectedVersion },
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function unarchiveMission(
  request: APIRequestContext,
  token: string,
  missionId: string,
): Promise<void> {
  await request.post(`/api/missions/${missionId}/unarchive`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function deleteHabitat(
  request: APIRequestContext,
  token: string,
  habitatId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await request.delete(`/api/habitats/${habitatId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status() === 429) {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    return;
  }
}

/**
 * Scoped habitat helper — creates a habitat, runs the test body, and cleans up.
 */
export async function withHabitat(
  token: string,
  request: APIRequestContext,
  name: string,
  fn: (ctx: {
    habitatId: string;
    columns: Array<{ id: string; name: string; order: number }>;
    token: string;
  }) => Promise<void>,
): Promise<void> {
  const { habitat, columns } = await createHabitat(request, token, name);
  try {
    await fn({ habitatId: habitat.id, columns, token });
  } finally {
    await deleteHabitat(request, token, habitat.id);
  }
}
