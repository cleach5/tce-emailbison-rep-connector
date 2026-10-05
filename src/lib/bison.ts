import { WORKSPACE_ID } from "./constants";

export class BisonError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}
