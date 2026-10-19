import { dropGitLocation } from "./git-env";

// Every test file's process, so a git command a test spawns finds only the
// repository the test made.
dropGitLocation(process.env);
