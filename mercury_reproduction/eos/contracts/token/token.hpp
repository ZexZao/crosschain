#pragma once
#include <eosio/asset.hpp>
#include <eosio/eosio.hpp>

using namespace eosio;

class [[eosio::contract("token")]] token : public contract {
public:
    using contract::contract;
    [[eosio::action]] void create(name issuer, asset maximum_supply);
    [[eosio::action]] void issue(name to, asset quantity, std::string memo);
    [[eosio::action]] void transfer(name from, name to, asset quantity, std::string memo);

private:
    struct [[eosio::table]] account { asset balance; uint64_t primary_key() const { return balance.symbol.code().raw(); } };
    struct [[eosio::table]] currency_stats {
        asset supply;
        asset max_supply;
        name issuer;
        uint64_t primary_key() const { return supply.symbol.code().raw(); }
    };
    using accounts = multi_index<"accounts"_n, account>;
    using stats = multi_index<"stat"_n, currency_stats>;
    void sub_balance(name owner, asset value);
    void add_balance(name owner, asset value, name ram_payer);
};
