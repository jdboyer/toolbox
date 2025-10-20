import { useState } from "react";
import { ActionIcon, Box, Flex, Paper, Stack } from "@mantine/core";
import { IconMenu2 } from "@tabler/icons-react";
import { GeneralSettings } from "./GeneralSettings";

type SidebarSection = "general" | null;

export function Sidebar() {
  const [activeSection, setActiveSection] = useState<SidebarSection>(null);

  const handleSectionClick = (section: SidebarSection) => {
    setActiveSection(activeSection === section ? null : section);
  };

  const renderContent = () => {
    switch (activeSection) {
      case "general":
        return <GeneralSettings />;
      default:
        return null;
    }
  };

  return (
    <Flex style={{ height: '100%' }}>
      {/* Icon button column */}
      <Stack
        gap="xs"
        p="xs"
        style={{
          borderRight: '1px solid var(--mantine-color-default-border)',
          paddingLeft: 0,
          paddingTop: 0,
          paddingBottom: 0
        }}
      >
        <ActionIcon
          variant={activeSection === "general" ? "filled" : "subtle"}
          size="lg"
          onClick={() => handleSectionClick("general")}
        >
          <IconMenu2 size={18} />
        </ActionIcon>
      </Stack>

      {/* Expandable content area */}
      {activeSection && (
        <Paper withBorder style={{ minWidth: '250px' }}>
          {renderContent()}
        </Paper>
      )}
    </Flex>
  );
}
