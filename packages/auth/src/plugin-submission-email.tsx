/** @jsxRuntime automatic */
import type { TransactionalEmail } from "@cortexai-agent-hub/adapter-kit";
import { Link, Text } from "react-email";
import { linkStyle, message } from "./email.js";

// Anyone can submit with any address, so the submitter's copy repeats nothing they typed.
export function pluginSubmissionReceivedEmail(email: string): Promise<TransactionalEmail> {
  return message(
    email,
    "We received your CortexAI Agent Hub plugin",
    <>
      <Text>Thanks for submitting a plugin to the CortexAI Agent Hub marketplace.</Text>
      <Text>We review every submission and will email you when it's done.</Text>
      <Text>If you did not submit a plugin, ignore this email.</Text>
    </>,
  );
}

export function pluginSubmissionAdminEmail(
  to: string,
  submission: { name: string; source: string; email: string },
  reviewUrl: string,
): Promise<TransactionalEmail> {
  return message(
    to,
    `New plugin submission: ${submission.name}`,
    <>
      <Text>
        {submission.name} from {submission.email}
      </Text>
      <Text>{submission.source}</Text>
      <Text>
        <Link href={reviewUrl} style={linkStyle}>
          Review
        </Link>
      </Text>
    </>,
  );
}

export function pluginSubmissionReviewedEmail(submission: {
  email: string;
  name: string;
  status: "approved" | "rejected";
  reason: string | null;
}): Promise<TransactionalEmail> {
  const approved = submission.status === "approved";
  return message(
    submission.email,
    approved
      ? `${submission.name} is in the CortexAI Agent Hub marketplace`
      : `Your CortexAI Agent Hub plugin submission: ${submission.name}`,
    <>
      <Text>
        {approved
          ? `${submission.name} is now listed in the CortexAI Agent Hub plugin marketplace.`
          : `We couldn't list ${submission.name} in the CortexAI Agent Hub plugin marketplace.`}
      </Text>
      {submission.reason ? <Text>{submission.reason}</Text> : null}
      <Text>Have any questions? Reply to this email.</Text>
    </>,
  );
}
