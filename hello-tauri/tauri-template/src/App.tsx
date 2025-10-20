import { useState, useEffect } from "react";
import { Box, Combobox, Flex, Group, Progress, Stack, Text, useCombobox, InputBase } from "@mantine/core";
import { invoke } from "@tauri-apps/api/core";
import { Sampler } from "./sampler";

interface AudioDevice {
  name: string;
  id: string;
}

function App() {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [primaryDevice, setPrimaryDevice] = useState<string | null>(null);
  const [secondaryDevice, setSecondaryDevice] = useState<string | null>(null);
  const [primaryVolume, setPrimaryVolume] = useState(0);
  const [secondaryVolume, setSecondaryVolume] = useState(0);

  const primaryCombobox = useCombobox({
    onDropdownClose: () => primaryCombobox.resetSelectedOption(),
  });

  const secondaryCombobox = useCombobox({
    onDropdownClose: () => secondaryCombobox.resetSelectedOption(),
  });

  // Load audio devices on mount
  useEffect(() => {
    loadAudioDevices();
  }, []);

  // Monitor volume levels
  useEffect(() => {
    const interval = setInterval(async () => {
      if (primaryDevice) {
        try {
          const volume = await invoke<number>("get_volume", { isPrimary: true });
          setPrimaryVolume(volume);
        } catch (error) {
          console.error("Failed to get primary volume:", error);
        }
      } else {
        setPrimaryVolume(0);
      }

      if (secondaryDevice) {
        try {
          const volume = await invoke<number>("get_volume", { isPrimary: false });
          setSecondaryVolume(volume);
        } catch (error) {
          console.error("Failed to get secondary volume:", error);
        }
      } else {
        setSecondaryVolume(0);
      }
    }, 100); // Update every 100ms for smooth animation

    return () => clearInterval(interval);
  }, [primaryDevice, secondaryDevice]);

  // Handle device changes
  useEffect(() => {
    const handlePrimaryChange = async () => {
      if (primaryDevice) {
        try {
          await invoke("start_monitoring", {
            deviceId: primaryDevice,
            isPrimary: true
          });
        } catch (error) {
          console.error("Failed to start monitoring primary device:", error);
        }
      } else {
        try {
          await invoke("stop_monitoring", { isPrimary: true });
        } catch (error) {
          console.error("Failed to stop monitoring primary device:", error);
        }
      }
    };

    handlePrimaryChange();
  }, [primaryDevice]);

  useEffect(() => {
    const handleSecondaryChange = async () => {
      if (secondaryDevice) {
        try {
          await invoke("start_monitoring", {
            deviceId: secondaryDevice,
            isPrimary: false
          });
        } catch (error) {
          console.error("Failed to start monitoring secondary device:", error);
        }
      } else {
        try {
          await invoke("stop_monitoring", { isPrimary: false });
        } catch (error) {
          console.error("Failed to stop monitoring secondary device:", error);
        }
      }
    };

    handleSecondaryChange();
  }, [secondaryDevice]);

  const loadAudioDevices = async () => {
    try {
      const deviceList = await invoke<AudioDevice[]>("get_audio_devices");
      setDevices(deviceList);
    } catch (error) {
      console.error("Failed to load audio devices:", error);
    }
  };

  const primaryDeviceName = devices.find(d => d.id === primaryDevice)?.name || "None";
  const secondaryDeviceName = devices.find(d => d.id === secondaryDevice)?.name || "None";

  const primaryOptions = [
    <Combobox.Option value="none" key="none">None</Combobox.Option>,
    ...devices.map((device) => (
      <Combobox.Option value={device.id} key={device.id}>
        {device.name}
      </Combobox.Option>
    ))
  ];

  const secondaryOptions = [
    <Combobox.Option value="none" key="none">None</Combobox.Option>,
    ...devices.map((device) => (
      <Combobox.Option value={device.id} key={device.id}>
        {device.name}
      </Combobox.Option>
    ))
  ];

  return (
    <Flex p="md" gap="md" style={{ height: '100vh' }}>
      <Box>
        <Stack gap="md">
          <Box style={{ width: '180px' }}>
            <Group align="center" justify="space-between" mb={5} wrap="nowrap">
              <Text size="sm" fw={500} style={{ whiteSpace: 'nowrap' }}>Primary</Text>
              <Progress value={primaryVolume} size="sm" style={{ width: '80px', marginLeft: 'auto' }} />
            </Group>
            <Combobox
              store={primaryCombobox}
              onOptionSubmit={(val) => {
                setPrimaryDevice(val === "none" ? null : val);
                primaryCombobox.closeDropdown();
              }}
            >
              <Combobox.Target>
                <InputBase
                  component="button"
                  type="button"
                  pointer
                  rightSection={<Combobox.Chevron />}
                  onClick={() => primaryCombobox.toggleDropdown()}
                  rightSectionPointerEvents="none"
                >
                  {primaryDeviceName}
                </InputBase>
              </Combobox.Target>

              <Combobox.Dropdown>
                <Combobox.Options>{primaryOptions}</Combobox.Options>
              </Combobox.Dropdown>
            </Combobox>
          </Box>

          <Box style={{ width: '180px' }}>
            <Group align="center" justify="space-between" mb={5} wrap="nowrap">
              <Text size="sm" fw={500} style={{ whiteSpace: 'nowrap' }}>Secondary</Text>
              <Progress value={secondaryVolume} size="sm" style={{ width: '80px', marginLeft: 'auto' }} />
            </Group>
            <Combobox
              store={secondaryCombobox}
              onOptionSubmit={(val) => {
                setSecondaryDevice(val === "none" ? null : val);
                secondaryCombobox.closeDropdown();
              }}
            >
              <Combobox.Target>
                <InputBase
                  component="button"
                  type="button"
                  pointer
                  rightSection={<Combobox.Chevron />}
                  onClick={() => secondaryCombobox.toggleDropdown()}
                  rightSectionPointerEvents="none"
                >
                  {secondaryDeviceName}
                </InputBase>
              </Combobox.Target>

              <Combobox.Dropdown>
                <Combobox.Options>{secondaryOptions}</Combobox.Options>
              </Combobox.Dropdown>
            </Combobox>
          </Box>
        </Stack>
      </Box>

      <Box style={{ flex: 1 }}>
        <Sampler />
      </Box>
    </Flex>
  );
}

export default App;
