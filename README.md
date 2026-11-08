# REAL / OR

A custom mobile camera application built with React Native, Expo, and VisionCamera, designed to bypass aggressive smartphone computational post-processing and artificial image enhancements to capture raw, authentic visual outputs.

## Overview

Modern smartphone cameras rely heavily on automated multi-frame blending, aggressive noise reduction, sharpening algorithms, and heavy tone-mapping. **REAL / OR** is engineered to strip away these layers, providing developers and creators with granular control over camera pipelines, manual settings, and direct frame processing.

## Core Features

- **Bypass Computational Processing:** Direct camera pipeline access minimizing automated algorithmic alterations.
- **VisionCamera Powered:** High-performance native frame processing using `react-native-vision-camera`.
- **Custom Viewfinder Interface:** Distraction-free custom UI focused strictly on manual controls and exposure.
- **Cross-Platform Foundation:** Built on React Native and Expo for extensible mobile development.

## Tech Stack

- **Framework:** React Native / Expo
- **Camera Module:** `react-native-vision-camera`
- **Language:** TypeScript
- **CI/CD & Automation:** Codemagic

## Getting Started

### Prerequisites

- Node.js (v18 or newer)
- Xcode (for iOS builds)
- CocoaPods

### Installation & Setup

```bash
# Clone the repository
git clone [https://github.com/uddeshmulik142-spec/RealOr.git](https://github.com/uddeshmulik142-spec/RealOr.git)
cd RealOr

# Install project dependencies
npm install

# Install iOS CocoaPods
cd ios && pod install && cd ..

# Run the application on iOS
npx expo run:ios
