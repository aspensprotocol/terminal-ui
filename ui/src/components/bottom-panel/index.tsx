"use client";

import { useState } from "react";
import { Balances } from "./Balances";
import { RecentOrders } from "./RecentOrders";
import { RecentTrades } from "./RecentTrades";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function BottomPanel() {
  const [activeTab, setActiveTab] = useState("balances");

  return (
    <div className="w-full h-[600px]">
      <Card className="p-0 overflow-hidden w-full h-full flex flex-col">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col h-full">
          <TabsList className="justify-start rounded-none border-b border-border h-auto p-0 bg-card backdrop-blur-sm shrink-0">
            <TabsTrigger value="balances" className="rounded-none px-4 text-sm">
              Balances
            </TabsTrigger>
            <TabsTrigger value="orders" className="rounded-none px-4 text-sm ">
              Orders
            </TabsTrigger>
            <TabsTrigger value="trades" className="rounded-none px-4 text-sm ">
              Trades
            </TabsTrigger>
          </TabsList>

          {/* Always mount all components to keep hooks running and data fresh */}
          <div className="flex-1 overflow-hidden relative">
            <div className={`h-full ${activeTab === "balances" ? "block" : "hidden"}`}>
              <Balances />
            </div>
            <div className={`h-full ${activeTab === "orders" ? "block" : "hidden"}`}>
              <RecentOrders />
            </div>
            <div className={`h-full ${activeTab === "trades" ? "block" : "hidden"}`}>
              <RecentTrades />
            </div>
          </div>
        </Tabs>
      </Card>
    </div>
  );
}
