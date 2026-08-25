export async function parseApiResponse<T extends Record<string, unknown>>(
  response: Response
): Promise<T> {
  const responseText = await response.text();

  if (!responseText) {
    return {} as T;
  }

  try {
    return JSON.parse(responseText) as T;
  } catch {
    return {
      error:
        response.status >= 500
          ? "O servidor está temporariamente indisponível. Tente novamente em alguns instantes."
          : "O servidor retornou uma resposta inválida. Atualize a página e tente novamente."
    } as unknown as T;
  }
}