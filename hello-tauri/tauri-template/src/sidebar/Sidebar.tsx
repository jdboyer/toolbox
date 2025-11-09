import { useState } from "react";
import { ActionIcon, Box, Flex } from "@mantine/core";
import { IconMenu2, IconPalette, IconWaveSine } from "@tabler/icons-react";
import { GeneralSettings } from "./GeneralSettings";
import { ColorSettings } from "./ColorSettings";
import { AirwaveSettings } from "./AirwaveSettings";

type SidebarSection = "general" | "colors" | "airwave" | null;

interface SidebarProps {
  color0?: string;
  color1?: string;
  color2?: string;
  color3?: string;
  color4?: string;
  onColor0Change?: (value: string) => void;
  onColor1Change?: (value: string) => void;
  onColor2Change?: (value: string) => void;
  onColor3Change?: (value: string) => void;
  onColor4Change?: (value: string) => void;
}

export function Sidebar({
  color0 = "#440154",
  color1 = "#3b528b",
  color2 = "#21918c",
  color3 = "#5ec962",
  color4 = "#fde725",
  onColor0Change = () => {},
  onColor1Change = () => {},
  onColor2Change = () => {},
  onColor3Change = () => {},
  onColor4Change = () => {},
}: SidebarProps = {}) {
  const [activeSection, setActiveSection] = useState<SidebarSection>(null);

  const handleSectionClick = (section: SidebarSection) => {
    setActiveSection(activeSection === section ? null : section);
  };

  const renderContent = () => {
    switch (activeSection) {
      case "general":
        return <GeneralSettings />;
      case "colors":
        return (
          <ColorSettings
            color0={color0}
            color1={color1}
            color2={color2}
            color3={color3}
            color4={color4}
            onColor0Change={onColor0Change}
            onColor1Change={onColor1Change}
            onColor2Change={onColor2Change}
            onColor3Change={onColor3Change}
            onColor4Change={onColor4Change}
          />
        );
      case "airwave":
        return <AirwaveSettings />;
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
          color={activeSection === "general" ? undefined : "gray"}
          size="lg"
          onClick={() => handleSectionClick("general")}
        >
          <IconMenu2 size={18} />
        </ActionIcon>
        <ActionIcon
          variant={activeSection === "colors" ? "filled" : "subtle"}
          color={activeSection === "colors" ? undefined : "gray"}
          size="lg"
          onClick={() => handleSectionClick("colors")}
        >
          <IconPalette size={18} />
        </ActionIcon>
        <ActionIcon
          variant={activeSection === "airwave" ? "filled" : "subtle"}
          color={activeSection === "airwave" ? undefined : "gray"}
          size="lg"
          onClick={() => handleSectionClick("airwave")}
        >
          <IconWaveSine size={18} />
        </ActionIcon>
      </Box>

      {/* Expandable content area */}
      {activeSection && (
        <Box style={{ minWidth: '250px', borderRight: '1px solid var(--mantine-color-default-border)' }}>
          {renderContent()}
        </Box>
      )}
    </Flex>
  );
}
