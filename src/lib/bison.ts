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

type Actor = "rep" | "admin";

const ALLOWED: { method: string; pattern: RegExp }[] = [
  { method: "GET", pattern: /^\/api\/users$/ },
  { method: "GET", pattern: /^\/api\/campaigns$/ },
  { method: "POST", pattern: /^\/api\/campaigns$/ },
  { method: "GET", pattern: /^\/api\/campaigns\/\d+$/ },
  { method: "PATCH", pattern: /^\/api\/campaigns\/\d+\/update$/ },
  { method: "PATCH", pattern: /^\/api\/campaigns\/\d+\/pause$/ },
  { method: "PATCH", pattern: /^\/api\/campaigns\/\d+\/resume$/ },
  { method: "GET", pattern: /^\/api\/campaigns\/\d+\/schedule$/ },
  { method: "POST", pattern: /^\/api\/campaigns\/\d+\/schedule$/ },
  { method: "PUT", pattern: /^\/api\/campaigns\/\d+\/schedule$/ },
  { method: "GET", pattern: /^\/api\/campaigns\/v1\.1\/\d+\/sequence-steps$/ },
  { method: "POST", pattern: /^\/api\/campaigns\/v1\.1\/\d+\/sequence-steps$/ },
  { method: "PUT", pattern: /^\/api\/campaigns\/v1\.1\/sequence-steps\/\d+$/ },
  { method: "POST", pattern: /^\/api\/campaigns\/\d+\/attach-sender-emails$/ },
  { method: "GET", pattern: /^\/api\/campaigns\/\d+\/sender-emails$/ },
  { method: "GET", pattern: /^\/api\/campaigns\/\d+\/leads$/ },
  { method: "GET", pattern: /^\/api\/campaigns\/\d+\/scheduled-emails$/ },
  { method: "GET", pattern: /^\/api\/campaigns\/\d+\/line-area-chart-stats$/ },
  { method: "POST", pattern: /^\/api\/campaigns\/\d+\/leads\/attach-leads$/ },
  { method: "GET", pattern: /^\/api\/scheduled-emails$/ },
  { method: "GET", pattern: /^\/api\/sender-emails$/ },
  { method: "POST", pattern: /^\/api\/leads\/create-or-update\/multiple$/ },
  { method: "GET", pattern: /^\/api\/tags$/ },
  { method: "POST", pattern: /^\/api\/tags$/ },
  { method: "POST", pattern: /^\/api\/tags\/attach-to-campaigns$/ },
  { method: "POST", pattern: /^\/api\/tags\/attach-to-sender-emails$/ },
];
