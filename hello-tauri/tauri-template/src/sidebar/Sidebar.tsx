import { useState } from "react";
import { ActionIcon, Box, Flex, Paper } from "@mantine/core";
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
      <Box
        style={{
          borderRight: '1px solid var(--mantine-color-default-border)',
          padding: 'var(--mantine-spacing-xs)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--mantine-spacing-xs)'
        }}
      >
        <ActionIcon
          variant={activeSection === "general" ? "filled" : "subtle"}
          size="lg"
          onClick={() => handleSectionClick("general")}
        >
          <IconMenu2 size={18} />
        </ActionIcon>
      </Box>

      {/* Expandable content area */}
      {activeSection && (
        <Paper withBorder style={{ minWidth: '250px' }}>
          {renderContent()}
        </Paper>
      )}
    </Flex>
  );
}
