export function webhookCredential(baseUrl: string, endpointId: string, secret: string) {
  const endpointUrl = `${baseUrl.replace(/\/$/, "")}/hooks/${endpointId}`;
  return {
    endpointUrl,
    secret,
    url: `${endpointUrl}/${encodeURIComponent(secret)}`,
  };
}
