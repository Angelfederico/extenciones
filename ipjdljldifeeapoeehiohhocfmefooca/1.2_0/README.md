# Gemini Prompt Automator

A Chrome Extension to automate generating images with Gemini.

## Installation

1.  Open Chrome and navigate to `chrome://extensions/`.
2.  Enable **Developer mode** in the top right corner.
3.  Click **Load unpacked**.
4.  Select the `gemini_extension` folder in this directory.

## Usage

1.  Prepare a CSV file with your prompts. The file should have one prompt per line.
    *   Example `prompts.csv`:
        ```csv
        A futuristic city with flying cars
        A portrait of a cat in a spacesuit
        A landscape of Mars with a colony
        ```
2.  Open [Gemini](https://gemini.google.com/).
3.  Click the **Gemini Automator** extension icon in the Chrome toolbar.
4.  Click **Choose File** and select your CSV file.
5.  Click **Start Automation**.

## How it Works

1.  The extension reads the prompts from your CSV.
2.  It types the first prompt into the Gemini chat box and presses Enter.
3.  It waits for **60 seconds** for the image to generate.
4.  It finds the generated image and downloads it automatically.
5.  It repeats the process for the next prompt until all prompts are finished.

## Notes

-   **Do not close the Gemini tab** while the automation is running.
-   If the extension gets stuck, you can click **Stop** in the popup or refresh the page.
-   The extension relies on the structure of the Gemini webpage. If Google updates the UI, the extension might need to be updated.
