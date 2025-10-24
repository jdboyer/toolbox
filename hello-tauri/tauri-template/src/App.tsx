import { Box, Flex } from "@mantine/core";
import { useState } from "react";
import { Sampler } from "./sampler";
import { Sidebar } from "./sidebar";

function App() {
  // Colormap configuration (control points for gradient)
  const [color0, setColor0] = useState("#440154"); // Dark purple
  const [color1, setColor1] = useState("#3b528b"); // Blue
  const [color2, setColor2] = useState("#21918c"); // Teal
  const [color3, setColor3] = useState("#5ec962"); // Green
  const [color4, setColor4] = useState("#fde725"); // Yellow

  return (
    <Flex style={{ height: '100vh' }}>
      <Box>
        <Sidebar
          color0={color0}
          color1={color1}
          color2={color2}
          color3={color3}
          color4={color4}
          onColor0Change={setColor0}
          onColor1Change={setColor1}
          onColor2Change={setColor2}
          onColor3Change={setColor3}
          onColor4Change={setColor4}
        />
      </Box>

      <Box style={{ flex: 1 }} p="md">
        <Sampler
          color0={color0}
          color1={color1}
          color2={color2}
          color3={color3}
          color4={color4}
        />
      </Box>
    </Flex>
  );
}

export default App;
