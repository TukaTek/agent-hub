/** @jsxRuntime automatic */
import type { TransactionalEmail } from "@cortexai-agent-hub/adapter-kit";
import { ANDROID_APK_URL, IOS_APP_STORE_URL } from "@cortexai-agent-hub/contracts";
import { Link, Text } from "react-email";
import { emailText, greeting, linkStyle, message } from "./email.js";

const APPS: Readonly<Record<string, string>> = {
  iPhone: IOS_APP_STORE_URL,
  Android: ANDROID_APK_URL,
  Mac: "https://github.com/TukaTek/agent-hub/releases/latest",
  Windows: "https://github.com/TukaTek/agent-hub/releases/latest",
  Linux: "https://github.com/TukaTek/agent-hub/releases/latest",
};

export function welcomeEmail(
  user: { email: string; name: string },
  unsubscribeUrl: string,
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  return message(
    user.email,
    locale,
    say("Welcome to CortexAI Agent Hub"),
    <>
      <Text>{greeting(say, user.name)}</Text>
      <Text>{say("Thanks for signing up for CortexAI Agent Hub.")}</Text>
      <Text>
        {say("CortexAI Agent Hub also has apps for")}{" "}
        {/* The language's own list ("A, B, and C", "A, B y C"), with each app a link. */}
        {new Intl.ListFormat(locale, { type: "conjunction" })
          .formatToParts(Object.keys(APPS))
          .map((part, index) =>
            part.type === "element" ? (
              <Link key={part.value} href={APPS[part.value]} style={linkStyle}>
                {part.value}
              </Link>
            ) : (
              <span key={`${index}${part.value}`}>{part.value}</span>
            ),
          )}
        .
      </Text>
      <Text>
        {say("Questions or ideas?")}{" "}
        <Link href="https://discord.gg/RWwKa2Sn7h" style={linkStyle}>
          {say("Join us on Discord")}
        </Link>
        .
      </Text>
      <Text>
        {say("CortexAI Agent Hub is open source. If you like it,")}{" "}
        <Link href="https://github.com/TukaTek/agent-hub" style={linkStyle}>
          {say("a star on GitHub")}
        </Link>{" "}
        {say("helps others find it.")}
      </Text>
      <Text>
        {say("Want to run it on your own servers?")}{" "}
        <Link
          href="https://github.com/TukaTek/agent-hub/blob/main/docs/self-host.md"
          style={linkStyle}
        >
          {say("Self-host CortexAI Agent Hub")}
        </Link>
        .
      </Text>
      <Text>{say("Have any questions? Reply to this email.")}</Text>
      <Text>Elie</Text>
    </>,
    unsubscribeUrl,
  );
}
