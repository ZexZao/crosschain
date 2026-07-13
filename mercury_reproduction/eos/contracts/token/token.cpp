#include "token.hpp"

void token::create(name issuer, asset maximum_supply) {
    require_auth(get_self());
    check(maximum_supply.is_valid() && maximum_supply.amount > 0, "bad maximum supply");
    stats statstable(get_self(), maximum_supply.symbol.code().raw());
    check(statstable.find(maximum_supply.symbol.code().raw()) == statstable.end(), "token exists");
    statstable.emplace(get_self(), [&](auto& row) {
        row.supply = asset{0, maximum_supply.symbol}; row.max_supply = maximum_supply; row.issuer = issuer;
    });
}

void token::issue(name to, asset quantity, std::string memo) {
    auto code = quantity.symbol.code().raw();
    stats statstable(get_self(), code);
    const auto& st = statstable.get(code, "token missing");
    require_auth(st.issuer);
    check(quantity.is_valid() && quantity.amount > 0 && quantity.symbol == st.supply.symbol, "bad quantity");
    check(quantity.amount <= st.max_supply.amount - st.supply.amount, "supply exceeded");
    statstable.modify(st, same_payer, [&](auto& row) { row.supply += quantity; });
    add_balance(to, quantity, st.issuer);
}

void token::transfer(name from, name to, asset quantity, std::string memo) {
    check(from != to, "cannot transfer to self");
    require_auth(from);
    check(is_account(to), "receiver missing");
    auto code = quantity.symbol.code().raw();
    stats statstable(get_self(), code);
    const auto& st = statstable.get(code, "token missing");
    check(quantity.is_valid() && quantity.amount > 0 && quantity.symbol == st.supply.symbol, "bad quantity");
    require_recipient(from); require_recipient(to);
    sub_balance(from, quantity); add_balance(to, quantity, from);
}

void token::sub_balance(name owner, asset value) {
    accounts from_acnts(get_self(), owner.value);
    const auto& from = from_acnts.get(value.symbol.code().raw(), "no balance");
    check(from.balance.amount >= value.amount, "overdrawn balance");
    from_acnts.modify(from, owner, [&](auto& row) { row.balance -= value; });
}

void token::add_balance(name owner, asset value, name ram_payer) {
    accounts to_acnts(get_self(), owner.value);
    auto to = to_acnts.find(value.symbol.code().raw());
    if (to == to_acnts.end()) to_acnts.emplace(ram_payer, [&](auto& row) { row.balance = value; });
    else to_acnts.modify(to, same_payer, [&](auto& row) { row.balance += value; });
}

EOSIO_DISPATCH(token, (create)(issue)(transfer))
