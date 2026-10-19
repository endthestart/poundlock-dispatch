/** App-owned Pi resources. Project extensions, skills, prompts, and context stay disabled unless trusted. */
export const lockedPiResources = {
  systemPrompt: "",
  appendSystemPrompt: [] as string[],
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
};
