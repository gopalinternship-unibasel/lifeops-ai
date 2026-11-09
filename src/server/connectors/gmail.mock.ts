/**
 * Mock Gmail connector. Returns realistic seeded emails for users who have not connected Google
 * (demo mode). Replies to these emails can be drafted and saved as demo drafts; nothing is sent.
 */
export interface MockEmail {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  receivedAt: string;
  unread: boolean;
  extractedTask?: { title: string; deadline?: string; importance: "high" | "medium" | "low" };
}

export function fetchMockEmails(): MockEmail[] {
  const now = new Date();
  const inDays = (d: number) => new Date(now.getTime() + d * 86400000).toISOString();
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600000).toISOString();
  return [
    {
      id: "e1",
      from: "Prof. Marlow <marlow@university.edu>",
      subject: "Research paper — final draft due Friday",
      snippet: "Reminder that the final draft of your research paper is due in 2 days. Please ensure citations are complete…",
      receivedAt: hoursAgo(3),
      unread: true,
      extractedTask: { title: "Write research paper final draft", deadline: inDays(2), importance: "high" },
    },
    {
      id: "e2",
      from: "Acme Recruiting <careers@acme.io>",
      subject: "Onsite interview — next steps",
      snippet: "We'd like to confirm your onsite interview Monday at 10am. Please prepare a 20-minute system design…",
      receivedAt: hoursAgo(7),
      unread: true,
      extractedTask: { title: "Prepare for Acme onsite interview", deadline: inDays(4), importance: "high" },
    },
    {
      id: "e3",
      from: "Sam (friend)",
      subject: "Lunch this Saturday?",
      snippet: "Free for lunch this Saturday around 1pm? Let me know!",
      receivedAt: hoursAgo(11),
      unread: true,
      extractedTask: { title: "Lunch with Sam", deadline: inDays(3), importance: "low" },
    },
    {
      id: "e4",
      from: "Stripe",
      subject: "Your monthly summary",
      snippet: "Here's your usage and invoice summary for the month.",
      receivedAt: hoursAgo(20),
      unread: false,
    },
    {
      id: "e5",
      from: "Alicia (manager)",
      subject: "Team sync moved to 7 PM today",
      snippet: "Heads up — team sync is moved to 7 PM today. Please come prepared to walk through your demo script.",
      receivedAt: hoursAgo(2),
      unread: true,
      extractedTask: { title: "Team sync at 7 PM (revise demo script)", deadline: now.toISOString(), importance: "high" },
    },
  ];
}

/** Look up one demo email by id (e1…e5). The body is the snippet: demo emails are short. */
export function getMockEmail(id: string): MockEmail | null {
  return fetchMockEmails().find((email) => email.id === id) ?? null;
}
