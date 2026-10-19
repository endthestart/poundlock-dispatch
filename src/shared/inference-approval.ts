/** Explain destination uncertainty without equating a gateway or remote machine with an external provider. */
export function inferenceApprovalText(name: string, destination: string) {
  return destination === "external"
    ? {
        action: `Use ${name} through an external provider?`,
        reason:
          "Selected project context will be sent to this provider. This approval covers inference.",
      }
    : {
        action: `Confirm where ${name} is hosted`,
        reason:
          "Poundlock has not declared whether this model runs on your own infrastructure or with an external provider. To avoid repeated prompts for an internal model, confirm its location in Settings → Models → Advanced model settings. Allow once permits this request to send selected project context.",
      };
}

/** Route consequence appended to an inference approval so the card names where work runs. */
export function routeConsequence(route: "interactive" | "manager"): string {
  if (route === "manager")
    return "Route: Project Manager conversation. Project files stay on this Mac.";
  return "Route: Interactive worker in the attached folder on this Mac. Source is not uploaded.";
}
