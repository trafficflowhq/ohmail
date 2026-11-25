"use client";

import dynamic from "next/dynamic";

export const NoPageEntry = dynamic(() => import("./NoPageRoute").then((module) => module.NoPageRoute));
